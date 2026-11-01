// Skill descriptions are advice, and in testing agents sometimes skipped this one and wrote the
// feature straight into the checkout. So a request that looks like a transplant gets a reminder.
const REPOSITORY = /\b(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+/i;
const INTENT =
  /가져|이식|옮겨|포팅|따와|베껴|넣어|추가해|적용해|참고해|\b(port|transplant|bring|copy|migrate|borrow|lift|reuse|add|same)\b/i;

const REMINDER =
  "This request may ask to bring a feature from another repository into this project. If it does, invoke the repo-transplant:transplant skill before reading or writing any code. Writing the feature directly or from memory skips the license and security checks.";

let input = "";
for await (const chunk of process.stdin) input += chunk;

let prompt = "";
try {
  prompt = String(JSON.parse(input).prompt ?? "");
} catch {
  // Anything unreadable is not a request this hook understands.
}

if (REPOSITORY.test(prompt) && INTENT.test(prompt)) {
  const hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: REMINDER };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}
