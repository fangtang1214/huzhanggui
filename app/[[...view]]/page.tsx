import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { HuZhangGuiApp } from "@/components/huzhanggui-app";

export const dynamic = "force-dynamic";

export default async function AppPage({ params }: { params: Promise<{ view?: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { view = [] } = await params;
  return <HuZhangGuiApp initialUser={user} path={view} />;
}
