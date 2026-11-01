# Moving between frameworks or languages

When `stack_compare` reports `cross_framework` or `cross_language`, treat the work as a re-implementation from the spec. Line-by-line translation gives you foreign idioms and subtle bugs.

## Method

1. Write the spec with extra care. It is now the only bridge.
2. Port the source's tests into acceptance criteria before writing code.
3. Write the implementation in the target's native style. Ask how the target's team would solve this from the spec alone.
4. Verify against the spec.

## Concept mapping

| React                     | Vue                           | Svelte                      |
| ------------------------- | ----------------------------- | --------------------------- |
| `useState`                | `ref`                         | `$state`                    |
| `useMemo`                 | `computed`                    | `$derived`                  |
| `useEffect`               | `watch`, `onMounted`          | `$effect`                   |
| Custom hook               | Composable                    | Rune module (`.svelte.ts`)  |
| Context                   | `provide` / `inject`          | `setContext` / `getContext` |
| Children and render props | Slots                         | Snippets                    |
| Refs and `forwardRef`     | Template refs, `defineExpose` | `bind:this`                 |

| Express / Fastify | NestJS             | FastAPI                | Django               | Gin        |
| ----------------- | ------------------ | ---------------------- | -------------------- | ---------- |
| Route handler     | Controller method  | Path operation         | View                 | Handler    |
| Middleware        | Guard, Interceptor | Dependency, Middleware | Middleware           | Middleware |
| Schema validation | DTO with pipes     | Pydantic model         | Serializer or Form   | Binding    |
| Error middleware  | Exception filter   | Exception handler      | Exception middleware | Recovery   |

## Traps

- **Timing:** effect order, batching and cleanup differ. Check anything that relies on when code runs.
- **Reactivity:** Vue and Svelte track mutation, React expects new objects.
- **Concurrency:** Node's single event loop hides races that appear with Go goroutines or Python threads. Review shared state.
- **Types and numbers:** JS numbers, Python big ints, and Go integer sizes differ. Check money and ids.
- **Time and text:** zones, date formats, Unicode normalization, and sort order can differ between runtimes.
- **Nulls:** `undefined` and `null`, `None`, Go zero values and Rust `Option` do not map one to one, especially in JSON.
- **Library gaps:** a package may have no equivalent. Check with `package_inspect`, and prefer a small local implementation over a heavy dependency.

Port the source's edge-case tests. They catch exactly these differences.
