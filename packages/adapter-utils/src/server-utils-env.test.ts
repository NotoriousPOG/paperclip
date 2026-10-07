import { describe, expect, it } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("host database and authentication credential isolation", () => {
  it("does not pass control-plane credentials or libpq connection defaults to agents", () => {
    const source = { DATABASE_URL: "postgres://host-secret", DATABASE_MIGRATION_URL: "postgres://owner-secret", BETTER_AUTH_SECRET: "session-signing-secret", PGPASSWORD: "password", PGSERVICEFILE: "/host/pg_service.conf", PGPASSFILE: "/host/.pgpass", PGOPTIONS: "-c role=owner", PGUSER: "owner", PGDATABASE: "paperclip", PGHOST: "db", PGPORT: "5432", PGSSLKEY: "/host/key.pem", PATH: "/usr/bin", HOME: "/home/agent", CUSTOM_TASK_VALUE: "allowed" };
    expect(sanitizeInheritedPaperclipEnv(source)).toEqual({ PATH: "/usr/bin", HOME: "/home/agent", CUSTOM_TASK_VALUE: "allowed" });
    expect(source.PGPASSWORD).toBe("password");
  });
  it("does not retain case variants of host credential names", () => {
    expect(sanitizeInheritedPaperclipEnv({ database_url: "secret", PgPassword: "secret", better_auth_secret: "secret" })).toEqual({});
  });
});

it("removes host credentials from a real child process while preserving an explicit task binding", async () => {
  const keys = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "BETTER_AUTH_SECRET", "PGPASSWORD"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "fixture-host-secret";
    const result = await runChildProcess("credential-isolation-fixture", process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({hostKeys:['DATABASE_URL','DATABASE_MIGRATION_URL','BETTER_AUTH_SECRET','PGPASSWORD'].filter(k=>k in process.env),task:process.env.TASK_CREDENTIAL === 'fixture-task-secret'}))"],
      { cwd: process.cwd(), env: { TASK_CREDENTIAL: "fixture-task-secret" }, timeoutSec: 5, graceSec: 1, onLog: async () => {} });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hostKeys: [], task: true });
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
