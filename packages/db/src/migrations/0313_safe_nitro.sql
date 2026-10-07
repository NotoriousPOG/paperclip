CREATE TABLE "access_group_members" (
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	CONSTRAINT "access_group_members_group_id_membership_id_pk" PRIMARY KEY("group_id","membership_id"),
	CONSTRAINT "access_group_members_role_check" CHECK ("access_group_members"."role" in ('viewer', 'contributor'))
);
--> statement-breakpoint
CREATE TABLE "access_group_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_group_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	CONSTRAINT "access_group_resources_agent_uq" UNIQUE("group_id","agent_id"),
	CONSTRAINT "access_group_resources_project_uq" UNIQUE("group_id","project_id"),
	CONSTRAINT "access_group_resources_one_target" CHECK (num_nonnulls("access_group_resources"."agent_id", "access_group_resources"."project_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "access_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"audience" text DEFAULT 'team' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_groups_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "access_groups_company_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "access_groups_audience_check" CHECK ("access_groups"."audience" in ('team', 'company_users', 'company_agents'))
);
--> statement-breakpoint
CREATE TABLE "resource_access_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"secret_id" uuid,
	"group_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_access_scopes_agent_uq" UNIQUE("agent_id"),
	CONSTRAINT "resource_access_scopes_project_uq" UNIQUE("project_id"),
	CONSTRAINT "resource_access_scopes_secret_uq" UNIQUE("secret_id"),
	CONSTRAINT "resource_access_scopes_one_resource" CHECK (num_nonnulls("resource_access_scopes"."agent_id", "resource_access_scopes"."project_id", "resource_access_scopes"."secret_id") = 1),
	CONSTRAINT "resource_access_scopes_revision_positive" CHECK ("resource_access_scopes"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "resource_scope_maintenance" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "access_mode" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_company_id_group_id_access_groups_company_id_id_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."access_groups"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_company_id_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_group_notes" ADD CONSTRAINT "access_group_notes_company_id_group_id_access_groups_company_id_id_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."access_groups"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_group_resources" ADD CONSTRAINT "access_group_resources_company_id_group_id_access_groups_company_id_id_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."access_groups"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_group_resources" ADD CONSTRAINT "access_group_resources_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_group_resources" ADD CONSTRAINT "access_group_resources_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_groups" ADD CONSTRAINT "access_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_scopes" ADD CONSTRAINT "resource_access_scopes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_scopes" ADD CONSTRAINT "resource_access_scopes_company_id_secret_id_company_secrets_company_id_id_fk" FOREIGN KEY ("company_id","secret_id") REFERENCES "public"."company_secrets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_scopes" ADD CONSTRAINT "resource_access_scopes_company_id_group_id_access_groups_company_id_id_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."access_groups"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_scopes" ADD CONSTRAINT "resource_access_scopes_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_scopes" ADD CONSTRAINT "resource_access_scopes_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- paperclip_app is created after this migration commits. PostgreSQL rejects CREATE ROLE inside Drizzle's migration transaction.
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY resource_scope_ceiling ON "projects"
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('paperclip.auth_enforced', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (
      SELECT 1 FROM resource_access_scopes AS scope_row
      WHERE scope_row.project_id = projects.id
    )
    OR EXISTS (
      SELECT 1
      FROM resource_access_scopes AS scope_row
      INNER JOIN access_group_members AS group_member
        ON group_member.group_id = scope_row.group_id
       AND group_member.company_id = scope_row.company_id
      INNER JOIN company_memberships AS membership
        ON membership.id = group_member.membership_id
       AND membership.company_id = group_member.company_id
      WHERE scope_row.project_id = projects.id
        AND membership.status = 'active'
        AND membership.principal_type = current_setting('paperclip.principal_type', true)
        AND membership.principal_id = current_setting('paperclip.principal_id', true)
        AND (
          current_setting('paperclip.operation', true) IS DISTINCT FROM 'write'
          OR group_member.role = 'contributor'
        )
    )
  );
--> statement-breakpoint
CREATE POLICY resource_scope_ceiling ON "agents"
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('paperclip.auth_enforced', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (
      SELECT 1 FROM resource_access_scopes AS scope_row
      WHERE scope_row.agent_id = agents.id
    )
    OR EXISTS (
      SELECT 1
      FROM resource_access_scopes AS scope_row
      INNER JOIN access_group_members AS group_member
        ON group_member.group_id = scope_row.group_id
       AND group_member.company_id = scope_row.company_id
      INNER JOIN company_memberships AS membership
        ON membership.id = group_member.membership_id
       AND membership.company_id = group_member.company_id
      WHERE scope_row.agent_id = agents.id
        AND membership.status = 'active'
        AND membership.principal_type = current_setting('paperclip.principal_type', true)
        AND membership.principal_id = current_setting('paperclip.principal_id', true)
        AND (
          current_setting('paperclip.operation', true) IS DISTINCT FROM 'write'
          OR group_member.role = 'contributor'
        )
    )
  );
--> statement-breakpoint
CREATE POLICY resource_scope_ceiling ON "company_secrets"
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('paperclip.auth_enforced', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (
      SELECT 1 FROM resource_access_scopes AS scope_row
      WHERE scope_row.secret_id = company_secrets.id
    )
    OR EXISTS (
      SELECT 1
      FROM resource_access_scopes AS scope_row
      INNER JOIN access_group_members AS group_member
        ON group_member.group_id = scope_row.group_id
       AND group_member.company_id = scope_row.company_id
      INNER JOIN company_memberships AS membership
        ON membership.id = group_member.membership_id
       AND membership.company_id = group_member.company_id
      WHERE scope_row.secret_id = company_secrets.id
        AND membership.status = 'active'
        AND membership.principal_type = current_setting('paperclip.principal_type', true)
        AND membership.principal_id = current_setting('paperclip.principal_id', true)
        AND (
          current_setting('paperclip.operation', true) IS DISTINCT FROM 'write'
          OR group_member.role = 'contributor'
        )
    )
  );