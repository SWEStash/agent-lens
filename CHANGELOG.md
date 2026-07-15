## [0.5.2](https://github.com/SWEStash/agent-lens/compare/v0.5.1...v0.5.2) (2026-07-15)


### Bug Fixes

* **security:** tier detector findings by scope, cut false positives ([#5](https://github.com/SWEStash/agent-lens/issues/5)) ([70ff181](https://github.com/SWEStash/agent-lens/commit/70ff1816811f08f7224046ab2348f4b66387e682))

## [0.5.1](https://github.com/SWEStash/agent-lens/compare/v0.5.0...v0.5.1) (2026-07-15)


### Bug Fixes

* **security:** eliminate credential/privilege detector false positives ([6472cbd](https://github.com/SWEStash/agent-lens/commit/6472cbde7b015645a67de3a36d9c500218c15293))
* **security:** treat commented / printed / quoted commands as inert (detector v5) ([5ec0b26](https://github.com/SWEStash/agent-lens/commit/5ec0b262fdd6d97cdfaf3328cc9c7732285a5c71))
* **web:** scroll to and highlight the flagged message from a security finding ([e22e771](https://github.com/SWEStash/agent-lens/commit/e22e771bc76070ba640441ebd90b52b777d48930))

# [0.5.0](https://github.com/SWEStash/agent-lens/compare/v0.4.0...v0.5.0) (2026-07-14)


### Features

* **security:** retrospective security findings with triage ([47cff28](https://github.com/SWEStash/agent-lens/commit/47cff2878e7c6515abf219edc507ef6e248876c3))

# [0.4.0](https://github.com/SWEStash/agent-lens/compare/v0.3.0...v0.4.0) (2026-07-09)


### Features

* **ingest:** preserve newlines in tool-result summaries ([6021380](https://github.com/SWEStash/agent-lens/commit/6021380f292f4372be0f00b7a74c66dd7a5756de))
* **web:** render Bash as a shell console and Edit/Write as a colored diff ([626906f](https://github.com/SWEStash/agent-lens/commit/626906f448bcba6db70cc3a3b6b816249ae76108))

# [0.3.0](https://github.com/SWEStash/agent-lens/compare/v0.2.0...v0.3.0) (2026-07-05)


### Features

* ingest spilled full tool results + expand in UI (schema v11) ([40d75be](https://github.com/SWEStash/agent-lens/commit/40d75bee17c43fc41412b4f6b73a2f2eb011c6a4))
* ingest subagent metadata + schema-version guard (schema v10) ([f5b787d](https://github.com/SWEStash/agent-lens/commit/f5b787da032e4c31d3aa39bc15df39e245cb51bc))
* ingest workflow result sidecars + richer workflow inspection ([533bde8](https://github.com/SWEStash/agent-lens/commit/533bde80e3ba4cd7818192cc984e790e51c2a7a5))
* **web:** workflow phase graph — serve progress, fix connector, add descriptors ([616544a](https://github.com/SWEStash/agent-lens/commit/616544a348d0739296dd3f7b05964ac539d702c2))

# [0.2.0](https://github.com/SWEStash/agent-lens/compare/v0.1.0...v0.2.0) (2026-07-03)


### Features

* **web:** sortable columns, searchable filters, richer transcript rendering ([0135af3](https://github.com/SWEStash/agent-lens/commit/0135af34e5c11d699f9b91e2f9e47c9a845f521f))
