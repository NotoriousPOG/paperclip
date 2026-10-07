import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessGroupsApi } from "@/api/accessGroups";
import { queryKeys } from "@/lib/queryKeys";
import { authApi } from "@/api/auth";
import { useLocation } from "@/lib/router";

export function PrivateTeamGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession, retry: false, staleTime: 0, refetchInterval: 5000 });
  const access = useQuery({ queryKey: ["private-team-access", session.data?.user.id ?? "local-or-anonymous"], queryFn: accessGroupsApi.access, enabled: session.isSuccess, retry: false, staleTime: 0, refetchInterval: 5000 });
  if (location.pathname.startsWith("/invite/") || location.pathname === "/auth") return children;
  if (session.isLoading || access.isLoading) return <p className="p-6" role="status">Checking access...</p>;
  if (session.error || access.error) return <p className="p-6 text-destructive" role="alert">Unable to check your access. Reload to try again.</p>;
  return children;
}
