import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">PoE Flipper</h1>
      <LoginForm />
    </div>
  );
}
