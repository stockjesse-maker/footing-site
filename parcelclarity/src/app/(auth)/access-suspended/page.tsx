import type { Metadata } from "next";
import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Access suspended" };

export default async function AccessSuspendedPage() {
  const user = await requireUser("/access-suspended");
  return (
    <Card>
      <CardTitle className="text-2xl">Access is currently suspended</CardTitle>
      <CardDescription>
        Your account ({user.email}) is signed in, but the workspace you belong to is suspended. Please contact your 3PL or ParcelClarity support to restore access.
      </CardDescription>
      <form action={signOut} className="mt-6">
        <Button type="submit" variant="secondary" className="w-full">Sign out</Button>
      </form>
    </Card>
  );
}
