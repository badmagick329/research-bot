## Scope

- Do **only** what I explicitly ask. No extra refactors, cleanups, drive-by fixes, or “while I’m here” changes.
- If something is ambiguous, ask a single clarifying question. Otherwise, proceed.

## Coding style

- do not use service suffix for anything except use-case like services in application layer
- when installing packages, make sure you're installing the latest versions not some old package from your training data. unless we _need_ the old package for compatability
- add comments to all classes and public facing methods/functions. comments should explain the why not the what. when you make changes make sure the comments reflect the latest state of the code
- we are using clean architecture. domain models/entities in core, use-case like services in application layer, io like classes in infra etc.
- when adding a new feature prefer to create interfaces/ports first and get the rest of the functionality working. then implement and plug in the adaptor after
- this project uses bun
- If you need to validate something, prefer unit tests, typecheck, lint, or reasoning from code.

## Communication Style

- Be concise.
- Sacrifice grammar for concision.
- Prefer bullets over paragraphs.
- No motivational fluff.

## Output Rules

- When proposing commands, give the exact command(s) only.
- When editing files, state:
  - which files changed
  - what changed (1–3 bullets)
- Avoid large rewrites unless requested.

## Safety Checks

- If a change could break runtime behavior or public API, warn me before doing it.
- Don’t make irreversible changes (migrations, lockfile regen, formatting sweep) unless asked.

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.
