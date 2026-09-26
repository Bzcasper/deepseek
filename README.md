# dsh-bot-screen

The shared headless Xfce screen for [DeepSeek Harness](https://deepseek.com/harness) (`dsh`).
Wraps the local `bot-screen` CLI and enforces its control lease as a tool-level fence.

Same screen as Hermes, Grok, OpenCode, and Cline. One screen, many clients — this plugin
never starts a second X server.

## What it contributes

**Six model-callable tools**

| Tool | Purpose |
| --- | --- |
| `screen_status` | installed / running / display / who holds the lease. Call before any screen interaction. |
| `screen_start` | Start the screen if it is not running. Never installs packages. |
| `screen_stop` | Stop the screen. Refuses while a human holds control. |
| `screen_env` | `DISPLAY` / `XAUTHORITY` / `DBUS_SESSION_BUS_ADDRESS` for the screen. |
| `screen_takeover` | Give a human exclusive control. |
| `screen_release` | Hand control back to the agent. |

**A `tools/pre-execute` fence.** While a human holds the lease, every screen-capable tool is
denied with `human_has_control`, so the agent cannot click, type, or screenshot out from under
someone who is mid-login. The `screen_*` tools are deliberately **not** fenced: a locked-out
agent must still be able to read the lease and hand control back.

## Install

From GitHub (this repo), a local checkout, or npm:

```sh
dsh plugin --profile web add github:Bzcasper/deepseek   # or: add /home/bobby/projects/deepseek
dsh --profile web --dump-config                          # a "# == dsh-bot-screen" layer means it mounted
dsh web                                                  # then Settings -> Plugins shows the bundle
```

A local path install links the checkout, so editing `index.js` and restarting the profile is
enough — no reinstall.

## Configuration

Set in `cordis.patch.yml` (see the comments in the shipped file):

| Key | Default | Meaning |
| --- | --- | --- |
| `bin` | `~/agent-tools/bot-screen/bin/bot-screen` | CLI path |
| `name` | `default` | Screen name |
| `screenHome` | `~/.bot-screen/<name>` | Overrides the lease location |
| `fence` | see file | Comma-separated regexes matched against tool names, case-insensitively |

## Lease semantics

Mirrors `bot_screen.lease` exactly:

- a **missing** lease file means the agent holds the screen;
- a lease that exists but is **unreadable or malformed fails closed** — the human is treated as
  holding it, so a corrupt file can never let an agent drive a screen someone is typing into.

## Threat model

Screens are work surfaces, not security boundaries. The RFB socket, the X display, the browser
profile, and the lease file all belong to the gateway's OS user — the bot's own `terminal` tool
can reach them directly, bypassing this fence. The lease is a tool-level fence, not an OS one.
Do not type secrets into a bot you would not trust with them.

## Verified

24 harness assertions against the real CLI and a live screen, including a real takeover/release
cycle and the corrupt/unreadable-lease fail-closed matrix. `dsh` itself is not installed on this
host, so the Cordis wiring is verified against a stub `Context` and a stub `defineTool`; the CLI,
lease, and screen paths are real.
