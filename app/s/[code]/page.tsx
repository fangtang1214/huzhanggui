import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { SiyuanApp } from "@/components/siyuan-app";

export const dynamic = "force-dynamic";

export default async function ScanResultPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await getCurrentUser();
  const { code } = await params;
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/s/${code}`)}`);
  return <SiyuanApp initialUser={user} path={["samples", code]} />;
}

