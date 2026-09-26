/**
 * dsh-bot-screen — the shared headless Xfce screen for DeepSeek Harness.
 *
 * Contributes two things:
 *
 *  1. `screen_*` tools wrapping the `bot-screen` CLI (status, start, stop, env,
 *     takeover, release).
 *  2. A `tools/pre-execute` fence. While a human holds the control lease, every
 *     screen-capable tool is denied with `human_has_control` so the agent cannot
 *     click, type, or screenshot out from under them. The `screen_*` tools are
 *     excluded from the fence on purpose: the agent must stay able to read the
 *     lease and report that a human is holding the screen.
 *
 * The lease read mirrors `bot_screen.lease`: a missing lease file means the agent
 * holds; an unreadable or malformed one fails closed.
 */

import { execFile } from "node:child_process"
import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { defineTool } from "@deepseek-ai/dsh-tools"
import Schema from "@deepseek-ai/schemastery"

export const name = "bot-screen"
export const inject = ["tools"]

const DENIED = "human_has_control"
const OWN_TOOL = /^screen_/

/**
 * Plugin configuration, validated and defaulted by Schemastery while the plugin
 * loads. `apply(ctx, config)` receives the resolved value.
 */
export const Config = Schema.object({
  bin: Schema.string()
    .description("Path to the bot-screen CLI")
    .default(path.join(os.homedir(), "agent-tools/bot-screen/bin/bot-screen")),
  name: Schema.string().description("Screen name").default("default"),
  screenHome: Schema.string().description("Overrides the screen state home").default(""),
  fence: Schema.string()
    .description("Comma-separated regexes matched against tool names; screen_* tools are always exempt")
    .default("screenshot,^computer,playwright,(^|_)cua($|_),(^|_)browser,glass"),
})

function leasePath(cfg) {
  const home = cfg.screenHome || path.join(os.homedir(), ".bot-screen", cfg.name)
  return path.join(home, "bot-desktop", "lease.json")
}

function mintedPath(cfg) {
  const home = cfg.screenHome || path.join(os.homedir(), ".bot-screen", cfg.name)
  return path.join(home, "bot-desktop", "minted-viewers.json")
}

async function readLease(cfg) {
  try {
    const raw = await readFile(leasePath(cfg), "utf8")
    const data = JSON.parse(raw)
    if (data?.holder !== "human" && data?.holder !== "agent") throw new Error("bad holder")
    return {
      holder: data.holder,
      reason: String(data.reason || ""),
      epoch: Number(data.epoch || 0),
      viewerId: typeof data.viewer_id === "string" && data.viewer_id ? data.viewer_id : null,
    }
  } catch (err) {
    const missing = err?.code === "ENOENT"
    return {
      holder: missing ? "agent" : "human",
      reason: missing ? "" : "lease unreadable",
      epoch: 0,
      viewerId: null,
    }
  }
}

/**
 * Viewer ids that agent clients minted via screen_takeover, shared by every
 * bot-screen plugin client on this host. Missing or corrupt ids fail closed: an
 * unreadable registry must never let the agent drop a human's takeover.
 */
async function readMinted(cfg) {
  try {
    const data = JSON.parse(await readFile(mintedPath(cfg), "utf8"))
    if (!Array.isArray(data?.viewers)) throw new Error("bad shape")
    return new Set(data.viewers.filter((v) => typeof v === "string"))
  } catch {
    return new Set()
  }
}

async function writeMinted(cfg, ids) {
  try {
    const dir = path.dirname(mintedPath(cfg))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${mintedPath(cfg)}.tmp`
    await writeFile(tmp, JSON.stringify({ viewers: [...ids].sort() }) + "\n", { mode: 0o600 })
    await rename(tmp, mintedPath(cfg))
  } catch {
    // Best effort: a failed write means the id was never recorded, which fails
    // closed on release rather than open.
  }
}

/** True when a takeover this agent side minted may be released by viewer `id`. */
async function releaseAllowed(cfg, id, lease) {
  if (lease.holder !== "human") return { ok: true, why: "" }
  if (lease.viewerId && lease.viewerId !== id) {
    return { ok: false, why: `viewer '${id}' does not hold this screen` }
  }
  const minted = await readMinted(cfg)
  if (!lease.viewerId || !minted.has(lease.viewerId)) {
    return {
      ok: false,
      why: "this takeover was not minted by an agent client; ask the human to hand the screen back",
    }
  }
  return { ok: true, why: "" }
}

function denialReason(lease) {
  if (lease.holder !== "human") return ""
  return lease.reason ? `${DENIED}: ${lease.reason}` : DENIED
}

/** Runs the bot-screen CLI. Never throws: failures come back as text so the model
 *  can read the install hint or the refusal instead of an opaque error. */
function runCli(cfg, args, signal) {
  return new Promise((resolve) => {
    execFile(
      cfg.bin,
      [args[0], cfg.name, ...args.slice(1)],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "").trim()
        if (out) return resolve(out)
        if (err) return resolve(`bot-screen ${args[0]} failed: ${String(stderr ?? err).trim()}`)
        resolve("")
      },
    )
  })
}

/**
 * Builds one `screen_*` tool. `flags` are the CLI long options whose values come
 * from the model's arguments; a flag with no argument is dropped rather than sent
 * dangling, so the CLI reports a real error instead of consuming the next flag.
 *
 * @param {{ tool: string, action: string, description: string,
 *           parameters?: object, flags?: string[], cfg: object }} spec
 */
function screenTool(spec) {
  const flagNames = spec.flags ?? []
  return defineTool({
    name: spec.tool,
    description: spec.description,
    parameters: spec.parameters ?? {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      if (spec.guard) {
        const verdict = await spec.guard(args)
        if (verdict && !verdict.ok) return `refused: ${verdict.why}`
      }
      const extra = []
      for (const flag of flagNames) {
        const value = args[flag.replace(/^--/, "")]
        if (value !== undefined && value !== null) extra.push(flag, String(value))
      }
      const out = await runCli(spec.cfg, [spec.action, ...extra], exec.signal)
      if (spec.after) await spec.after(args, out)
      return out
    },
  })
}

/** Records the minted viewer id so this agent side can hand the takeover back. */
async function recordMinted(cfg) {
  const lease = await readLease(cfg)
  if (lease.holder === "human" && lease.viewerId) {
    const ids = await readMinted(cfg)
    ids.add(lease.viewerId)
    await writeMinted(cfg, ids)
  }
}

/** Forgets a released id. */
async function forgetMinted(cfg, id) {
  if ((await readLease(cfg)).holder === "human") return
  const ids = await readMinted(cfg)
  ids.delete(id)
  await writeMinted(cfg, ids)
}

export function apply(ctx, config) {
  const cfg = config
  const fence = String(cfg.fence)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s, "i"))

  const tools = [
    {
      tool: "screen_status",
      action: "status",
      description:
        "Status of the shared headless Xfce screen: installed, running, display, and who holds the control lease. Call this before any screen interaction.",
    },
    {
      tool: "screen_start",
      action: "start",
      description:
        "Start the shared headless screen if it is not running. Never install packages from an agent.",
    },
    {
      tool: "screen_stop",
      action: "stop",
      description:
        "Stop the shared headless screen. Refuses while a human holds control (only an operator may stop --force). Call when finished and the user did not ask to keep it up.",
    },
    {
      tool: "screen_env",
      action: "env",
      description:
        "DISPLAY / XAUTHORITY / DBUS_SESSION_BUS_ADDRESS exports for the shared screen. Never use the seat display (:0/:1) for agent work.",
    },
    {
      tool: "screen_takeover",
      action: "takeover",
      description:
        "Give a human exclusive control of the screen. Refuses while a different viewer already holds it. Record the viewer id you pass: only that id, or the human themselves, can release. Stop all screen interaction until it is released.",
      parameters: {
        viewer: { type: "string", required: true, description: "Viewer identifier, e.g. a browser tab id" },
        reason: { type: "string", required: true, description: "Why the human needs it, e.g. 'logging in'" },
      },
      flags: ["--viewer", "--reason"],
      after: () => recordMinted(cfg),
    },
    {
      tool: "screen_release",
      action: "release",
      description:
        "Hand control of the screen back to the agent. Only works for a takeover an agent client minted via screen_takeover; a human-initiated takeover must be released by the human.",
      parameters: {
        viewer: { type: "string", required: true, description: "The viewer id that took the screen" },
      },
      flags: ["--viewer"],
      guard: async (args) => releaseAllowed(cfg, args.viewer, await readLease(cfg)),
      after: (args) => forgetMinted(cfg, args.viewer),
    },
  ]

  for (const spec of tools) {
    ctx.tools.register(screenTool({ ...spec, cfg }))
  }

  ctx.on("tools/pre-execute", async (exec, next) => {
    const toolName = String(exec?.name ?? "")
    // This plugin's own tools are never fenced: an agent that is locked out of a
    // human's takeover must still be able to read the lease and hand control back.
    if (OWN_TOOL.test(toolName)) return next()
    if (!fence.some((re) => re.test(toolName))) return next()
    const why = denialReason(await readLease(cfg))
    if (why) return { kind: "deny", reason: why }
    return next()
  })
}
