import { Dashboard } from "@/components/dashboard";
import { getSessionState } from "@/app/actions/login";

export default async function Home() {
  const session = await getSessionState();
  return <Dashboard initialSession={session} />;
}
