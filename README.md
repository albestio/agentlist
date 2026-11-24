# agentList

agentList is a local web page that shows which agents, skills and instruction files exist on this machine, for both Pi and Claude, and what each one contains. It reads Markdown files from a fixed set of directories and never writes anything. One Node process, no dependencies, no build step.

## Requirements

- Node.js 20 or newer.
- `npm test` needs nothing else: the project has no runtime and no development dependencies.

## Install

```sh
gh repo clone albestio/agentlist
cd agentlist
npm start
```

There is no build step and nothing to install: the folder you clone is the program.

## Run

Start the server from the folder you want to inspect:

```sh
npm start
```

The page opens at `http://127.0.0.1:3000` and lists the folder you ran it from. Point it elsewhere without restarting:

```sh
npm start -- /path/to/project
PORT=4000 npm start
AGENTLIST_CWD=/path/to/project npm start
```

The folder field in the header reloads the lists for another directory at any time.

| Variable | Effect |
| --- | --- |
| `AGENTLIST_CWD` | Project folder scanned at startup, when no argument is given |
| `PI_CODING_AGENT_DIR` | Overrides the global Pi home (`~/.pi/agent`) |
| `CLAUDE_CONFIG_DIR` | Overrides the global Claude home (`~/.claude`) |
| `HOST` | Bind address, `127.0.0.1` by default |
| `PORT` | Listen port, `3000` by default |

## Where it reads from

Each ecosystem contributes two global roots and two project roots:

| Directory | Scope | Ecosystem |
| --- | --- | --- |
| `$PI_CODING_AGENT_DIR/agents/` | global | Pi |
| `$PI_CODING_AGENT_DIR/subagents/` | global | Pi |
| `<project>/.pi/agents/` | project | Pi |
| `<project>/.pi/subagents/` | project | Pi |
| `$CLAUDE_CONFIG_DIR/agents/` | global | Claude |
| `<project>/.claude/agents/` | project | Claude |

Skills and instruction files come from `skills/` under the Pi and Claude homes, from `~/.agents/skills/`, and from `AGENTS.md` and `CLAUDE.md` in the project and in each global home. The **Ecosystem** selector chooses Pi, Claude or both, applies to both tabs, and persists in `localStorage`; an `ecosystem` URL parameter wins over the stored value without overwriting it.

Directories are scanned in the order shown, and a later definition with the same name wins. The list marks the losing entries as *shadowed*. With `both` selected, an agent name exists once per ecosystem, so the effective id is `<ecosystem>:<name>` and the same name is never collapsed into one row. Frontmatter is shown verbatim: a Claude `model: sonnet` or `tools: Bash, Read` is not translated into Pi vocabulary.

## Security model

This page exposes the contents of your home directory to a browser, so it answers on loopback and checks where it is doing it.

- Nothing is written to disk. Every endpoint is a read.
- The server binds to `127.0.0.1` and rejects a request whose `Host` header is not a loopback name, which closes the DNS-rebinding path to `/api/*`. Setting `HOST` to any other address disables that check and prints a warning; do it only on a network you trust.
- `/api/doc` serves only a path that the current scan already discovered, and refuses anything above 1 MB. A request for an unknown path returns 404, including `/etc/hostname`.
- Scans stay bounded: files above 1 MB are read from a bounded head, and previews stop at 30 lines or 1200 characters.
- Responses carry `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a `Content-Security-Policy` restricted to same-origin assets, so a project folder in the URL is not leaked to third parties through the `Referer` header.
- File content is escaped before rendering, and Markdown links are limited to `http`, `https`, `mailto`, fragments and same-origin paths.

Symlinks are followed for skill *directories*, because Pi links its own skills that way, and ignored for regular files. Treat the folders you scan as trusted input.

Report a vulnerability through the [security advisory form](https://github.com/albestio/agentlist/security/advisories/new) rather than a public issue.

## Interface

- **Agents** lists every discovered definition with its scope, ecosystem, model and tools. Click a row to read its source path, frontmatter, tool list and instructions.
- **Docs** lists skills (`*/SKILL.md` and flat `.md`) and instruction files. Preview opens a side panel that locks the page behind it, so only the panel scrolls; **Read complete doc** fetches the whole file on demand.
- Search covers name, description, model and tools on the Agents tab, and name, description and path on the Docs tab. The query is shared between tabs.
- Filters, the selected agent, the open document, the tab and the project folder live in the URL, so back and forward move through the same views and a link restores them.
- "Effective names" counts the winners after precedence; "discovered" counts every file found.

## API

All endpoints take `cwd`, which must be an existing directory; an invalid one returns 400. Without it the server uses its startup folder.

| Request | Response |
| --- | --- |
| `GET /api/agents` | Sources, counts, issues and agent summaries without instruction bodies |
| `GET /api/agents/<name>` | Full detail for the effective agent, 404 when unknown |
| `GET /api/docs` | Skills and instruction files with bytes, lines and a bounded preview |
| `GET /api/doc?path=` | Full text of one scanned document: 400 without a path, 404 when not scanned, 413 above 1 MB |

A missing directory is reported as a source issue, not as an error, so a project without `.pi/skills` renders normally.

## Limits

- The listing is a snapshot per request; there is no file watcher, so reload after editing an agent.
- Only frontmatter keys are parsed. Instructions are shown as text, not interpreted.
- agentList is a viewer: it does not edit, validate or run the agents it lists.

## Tests

```sh
npm test
```

The suite runs on `node --test` against temporary fixtures, so it touches no real agent directory. CI runs it on Node 20, 22 and 24.

## Contributing

Open an issue before a large change, keep the dependency count at zero, and run `npm test` before sending a pull request. Behaviour that a test can pin belongs in a test.

## License

MIT. See [LICENSE](LICENSE).
