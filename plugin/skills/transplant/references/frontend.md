# Transplanting UI features

The goal is a feature that looks native to the target. Keep the source's behavior and drop its appearance.

## Design

`repo_profile` reports `design_system`: CSS variables, Tailwind config, theme files and UI primitives. Before writing markup:

1. Open two or three target pages close to this feature. Note spacing, type sizes, radii, density, and how they handle empty, loading and error states.
2. List the source's visual parts, and map each to a target primitive in the plan's `design_mapping`.

| Source                    | Target                                                     |
| ------------------------- | ---------------------------------------------------------- |
| Custom dialog             | The target's Dialog                                        |
| Hard-coded `#6366f1`      | The target's primary token                                 |
| `styled-components` block | Tailwind classes or CSS modules, whichever the target uses |
| Source icon set           | The target's icon set                                      |

Never hard-code a color, font or spacing value the target has a token for. Check dark mode if the target has it.

## Behavior to keep

- Keyboard behavior: focus order, focus trap and restore, Escape, arrow keys, and shortcuts that may clash with the target's.
- Accessibility: roles, labels, `aria-live` for changing results, and visible focus.
- Loading, empty and error states.
- Debounce and cancellation of in-flight requests.
- Mobile layout and touch targets.

## State and data

- Re-express stores with the target's state library. Keep the same transitions.
- Use the target's data-fetching client and keep cache keys and invalidation rules.
- Check the server/client boundary in frameworks that have one. Mark client components correctly, and keep secrets on the server.
- Reach the backend through the target's API client.

## Verifying

Run the feature, then look at it:

1. Start the target from the worktree through a dev server.
2. Use the feature by hand in a browser, including keyboard-only and the failure states.
3. Take screenshots at desktop and mobile widths, in light and dark mode if supported.
4. Compare with neighboring pages. Mismatched spacing and type stand out at once.

### Browser checks you can run without a browser tool

Unit tests in a simulated DOM have passed while the real page was wrong. If the plan can add a dev dependency, make a real browser part of verification:

1. Add `@playwright/test` to the plan, at the same version as the Playwright image.
2. Write a test under the target's test folder that starts the app, or uses the `webServer` option, and performs each user-facing acceptance criterion through the real wiring.
3. Add a command with kind `e2e`, such as `npx playwright test --reporter=list`, and set `verification.docker_image` to `mcr.microsoft.com/playwright:v<version>-noble`. Commands run with the network off, so everything the page needs must come from the app or from `verification.services`.
4. Quote the Playwright test name as the evidence for those criteria.

If the plan may not add packages, install it for the check alone with `npm install --no-save @playwright/test@<version>` in the install command, which leaves `package.json` unchanged, and keep the test folder out of the project's type check.

When comparing with the original, use a deployed demo. Do not run the source locally unless the user approves a sandbox. `visual_compare` is for layout regressions and for matching a reference. A transplant that adopts the target's design is meant to differ from the original.
