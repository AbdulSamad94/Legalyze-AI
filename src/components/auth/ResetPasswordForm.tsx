"use client";

import type React from "react";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { AlertCircle, ArrowRight, Lock } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useFormValidation } from "@/lib/hooks/useFormValidation";
import { FormInput } from "@/components/form/FormInput";
import { PasswordConfirmation } from "@/components/form/PasswordConfirmation";
import { PasswordStrengthMeter } from "@/components/form/PasswordStrengthMeter";
import { AuthBrandMark } from "@/components/auth/AuthBrandMark";

const CTA_CLASSES =
  "w-full bg-linear-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:shadow-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2";

const INVALID_LINK_MESSAGE =
  "This reset link is invalid or has expired. Please request a new one.";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token");
  const [isLoading, setIsLoading] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(!token);
  const [error, setError] = useState("");
  const {
    formData,
    fieldErrors,
    passwordStrength,
    handleFieldChange,
    validateField,
  } = useFormValidation();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const passwordError = validateField("password");
    const confirmError = validateField("confirmPassword");
    if (passwordError || confirmError || isLoading || !token) return;

    setIsLoading(true);
    setError("");

    try {
      const { error: apiError } = await authClient.resetPassword({
        newPassword: formData.password,
        token,
      });

      if (!apiError) {
        setIsReset(true);
      } else if (apiError.code === "INVALID_TOKEN") {
        setLinkInvalid(true);
      } else {
        setError(apiError.message || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const title = isReset
    ? "Password Updated"
    : linkInvalid
      ? "Link Not Valid"
      : "Set a New Password";

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4 sm:p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <AuthBrandMark />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
        </div>

        <div className="bg-white rounded-3xl shadow-xl border border-gray-100 p-6 sm:p-8">
          {isReset ? (
            <div className="space-y-6 text-center">
              <p className="text-gray-600">
                You can now sign in with your new password.
              </p>
              <Link href="/login" className={CTA_CLASSES}>
                Sign In <ArrowRight className="h-5 w-5" />
              </Link>
            </div>
          ) : linkInvalid ? (
            <div className="space-y-6 text-center">
              <p className="text-gray-600">{INVALID_LINK_MESSAGE}</p>
              <Link href="/forgot-password" className={CTA_CLASSES}>
                Request a New Link <ArrowRight className="h-5 w-5" />
              </Link>
            </div>
          ) : (
            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div className="p-4 rounded-2xl flex items-center gap-3 bg-red-50 border border-red-200 text-red-700">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
              <div>
                <FormInput
                  id="password"
                  name="password"
                  label="New Password"
                  type="password"
                  placeholder="Enter a new password"
                  value={formData.password}
                  error={fieldErrors.password}
                  icon={<Lock className="h-5 w-5 text-gray-400" />}
                  onChange={handleFieldChange}
                  autoComplete="new-password"
                  disabled={isLoading}
                />
                <PasswordStrengthMeter strength={passwordStrength} />
              </div>
              <PasswordConfirmation
                id="confirmPassword"
                name="confirmPassword"
                label="Confirm New Password"
                value={formData.confirmPassword}
                password={formData.password}
                error={fieldErrors.confirmPassword}
                onChange={handleFieldChange}
                disabled={isLoading}
              />
              <button type="submit" disabled={isLoading} className={CTA_CLASSES}>
                {isLoading ? "Resetting..." : "Reset Password"}
                {!isLoading && <ArrowRight className="h-5 w-5" />}
              </button>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
}
