import { z } from "zod";

const text = z.string().trim().min(1);

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d+$/, "Use ids like AC-1"),
  given: text,
  when: text,
  then: text,
  verification: z.enum(["unit", "integration", "contract", "e2e", "visual", "manual"]),
});

export const ApiContract = z.object({
  method: text,
  path: text,
  auth: text.describe('Who may call this. Use "public" only when the route is really public.'),
  request: text,
  response: text,
  errors: z.array(text).default([]),
  side_effects: z.array(text).default([]),
});

export const DataChange = z.object({
  entity: text,
  change: z.enum(["create", "alter", "reuse"]),
  fields: z.array(text).default([]),
  constraints: z.array(text).default([]),
});

export const EnvVar = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  purpose: text,
  required: z.boolean(),
  secret: z.boolean(),
});

export const FeatureSpec = z.object({
  name: text,
  summary: text,
  in_scope: z.array(text).min(1),
  out_of_scope: z.array(text).default([]),
  behaviors: z.array(text).min(1),
  edge_cases: z.array(text).default([]),
  acceptance_criteria: z.array(AcceptanceCriterion).min(1),
  frontend: z
    .object({
      components: z.array(text).default([]),
      state: z.array(text).default([]),
      interactions: z.array(text).default([]),
      accessibility: z.array(text).default([]),
    })
    .optional(),
  backend: z
    .object({
      api: z.array(ApiContract).default([]),
      data_model: z.array(DataChange).default([]),
      jobs: z.array(text).default([]),
      realtime: z.array(text).default([]),
      external_services: z.array(text).default([]),
      env: z.array(EnvVar).default([]),
      authorization: z.array(text).default([]),
      idempotency_and_consistency: z.array(text).default([]),
    })
    .optional(),
  backend_excluded_reason: z
    .string()
    .optional()
    .describe("Required when the traced feature has server code but this spec leaves it out."),
  source_refs: z.array(text).default([]),
});
export type FeatureSpec = z.infer<typeof FeatureSpec>;

export const PlanFile = z.object({
  path: text,
  action: z.enum(["create", "modify"]),
  purpose: text,
  source_refs: z.array(text).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
});

export const PlannedDependency = z.object({
  name: text,
  version: text,
  ecosystem: z.enum(["npm", "pypi", "go", "cargo", "rubygems", "packagist", "maven", "nuget"]),
  dev: z.boolean().default(false),
  reason: text,
});

export const Migration = z.object({
  path: text,
  reversible: z.boolean(),
  rollback: text.describe("How to undo it: the down migration path or the exact steps."),
  destructive: z.boolean().default(false),
  destructive_reason: z.string().optional(),
});

export const VerificationCommand = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  command: text,
  kind: z.enum(["install", "typecheck", "lint", "test", "build", "migration", "e2e", "other"]),
  timeout_s: z.number().int().positive().max(3600).default(600),
  env: z.record(z.string(), z.string()).default({}),
});

const ImageReference = z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i, "Must be an image reference");

const VerificationService = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,30}$/)
    .describe("Host name that commands use to reach it."),
  image: ImageReference,
  env: z.record(z.string(), z.string()).default({}),
  ready_command: z
    .string()
    .min(1)
    .describe("Runs inside the service until it succeeds, such as `pg_isready`."),
});

export const TransplantPlan = z.object({
  approach: text,
  files: z.array(PlanFile).min(1),
  dependencies: z.object({
    add: z.array(PlannedDependency).default([]),
    reuse: z.array(text).default([]),
    dropped: z.array(text).default([]),
  }),
  wiring: z.array(text).default([]),
  design_mapping: z.array(text).default([]),
  migrations: z.array(Migration).default([]),
  env_vars: z.array(EnvVar).default([]),
  verification: z.object({
    commands: z.array(VerificationCommand).min(1),
    docker_image: ImageReference.optional().describe(
      "Run commands in this image, on a copy of the worktree, instead of on the host.",
    ),
    services: z
      .array(VerificationService)
      .max(5)
      .default([])
      .describe("Databases and the like, on a private network with no internet. Needs docker_image."),
    no_browser_check_reason: z
      .string()
      .min(10)
      .optional()
      .describe("Why a plan that changes UI files has no e2e command. The user sees this before approving."),
  }),
  risks: z.array(text).default([]),
  rollback: text,
  sensitive_paths_reason: z
    .string()
    .optional()
    .describe("Required when the plan touches CI, agent configuration or install hooks."),
});
export type TransplantPlan = z.infer<typeof TransplantPlan>;

export const EvidenceInput = z.object({
  acceptance_criterion: z.string(),
  status: z.enum(["pass", "fail", "manual_required"]),
  kind: z.enum(["test", "screenshot", "manual_note"]),
  command_name: z.string().optional().describe("Verification command whose log proves this criterion."),
  log_contains: z
    .string()
    .optional()
    .describe("Exact text, such as the test name, that must appear in that command's log."),
  detail: text,
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;
