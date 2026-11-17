## Summary

<!-- What this changes and why, in a paragraph. Closes #… if there is an issue. -->

## Before asking for review

- [ ] `npm run build` and `npm test` pass locally; new behaviour has tests
- [ ] Only the files of this change are committed, by exact path (never `git add -A` / `git add .`: other agents share the working tree)
- [ ] User-visible change: an entry at the top of `CHANGELOG.md`
- [ ] Behaviour or architecture changed: the docs and specs say so
- [ ] Security rules still hold: envelope framing, official vendor channels only, loopback and token checks on the local API, agent CLIs run with an argv (never a shell)
