# Writing the behavior spec

The spec is the contract between the source and the transplant. Implementation follows the spec, and verification proves the spec, so a vague spec means an unproven transplant.

## Principles

**Describe behavior, not code.** "Results are ranked by match quality, and an exact prefix beats a substring" is a behavior. "Calls `commandScore()` in a `useMemo`" is an implementation detail.

**Extract behavior from evidence.** Read in this order: the source's tests, the integration points, the implementation, then the docs. Tests and call sites show what is really relied on. Docs often lag.

**Capture the unhappy paths.** Empty input, no results, slow network, double submit, expired session, permission denied, partial failure. Most of a feature's value and most of its bugs live here. List them in `edge_cases`.

**Draw the boundary on purpose.** `out_of_scope` matters as much as `in_scope`. Name what you are leaving behind and why.

## Acceptance criteria

Each criterion is one observable fact, in Given / When / Then form.

| Weak           | Strong                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Search works   | Given 3 items with one match for "inv", when the user types "inv", then 1 result is listed         |
| Handles errors | Given the API returns 500, when the form submits, then the form stays filled and an error is shown |
| Secure         | Given no session, when POST /comments is called, then the response is 401 and nothing is stored    |

Choose `verification` honestly:

- `integration`, `contract`, `e2e`: an automated test proves it through the real entry point. Prefer these for anything a user sees.
- `unit`: an automated test proves a piece in isolation. Use it for pure logic, not for behavior that depends on what the caller passes.
- `visual`: a screenshot comparison proves it.
- `manual`: only a person or a real external service can prove it. Keep these rare, because they become open items in the report.

Write at least one criterion for each behavior, each edge case that matters, and each authorization rule. Do not make a criterion of something that may already fail before your change, such as a production build that needs real keys. Check the project first, and list it as a risk instead.

## Source references

Put the source paths you relied on in `source_refs`. In the plan, `source_refs` on each file also power the verbatim-copy check, the provenance record and later upstream comparison.
