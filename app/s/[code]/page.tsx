import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { HuZhangGuiApp } from "@/components/huzhanggui-app";

export const dynamic = "force-dynamic";

export default async function ScanResultPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await getCurrentUser();
  const { code } = await params;
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/s/${code}`)}`);
  return <HuZhangGuiApp initialUser={user} path={["samples", code]} />;
}
