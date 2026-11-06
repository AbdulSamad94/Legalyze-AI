import { Suspense } from "react";
import type { Metadata } from "next";
import { Loader2 } from "lucide-react";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = {
  title: "Reset Your Password",
  robots: {
    index: false,
    follow: false,
  },
};

const LoadingFallback = () => (
  <div className="min-h-screen bg-linear-to-br from-slate-50 to-blue-50 flex items-center justify-center p-8">
    <div className="inline-flex p-4 bg-blue-100 rounded-full">
      <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
    </div>
    <span className="sr-only">Loading...</span>
  </div>
);

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
