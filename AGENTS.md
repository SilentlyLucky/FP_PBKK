# Project agent guidance

These instructions govern development work in this repository. PromptLab's target runtime disables project document loading, so these files do not inject policy into user-generated target sessions.

Read [the project agent workflow](docs/AGENT_WORKFLOW.md) before making changes. It records the shell-command, implementation, verification, and safety practices for this project.

All shell commands must start with `rtk`. Use `rtk proxy <command>` for raw output or commands RTK does not support. Read any more-specific `AGENTS.md` that applies to the files being changed; those instructions add to this file.
