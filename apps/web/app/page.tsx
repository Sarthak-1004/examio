import { redirect } from "next/navigation";
import { homePathFor, requireSession } from "@/lib/auth";

export default async function Home() {
  const s = await requireSession();
  redirect(homePathFor(s));
}
