"use client";

import type React from "react";
import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useFormValidation } from "@/lib/hooks/useFormValidation";
import { FormInput } from "@/components/form/FormInput";
import { AuthBrandMark } from "@/components/auth/AuthBrandMark";

const ForgotPasswordPage = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { formData, fieldErrors, handleFieldChange, validateField } =
    useFormValidation();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (validateField("email") || isLoading) return;

    setIsLoading(true);
    // Every outcome shows the same confirmation so this page can't reveal
    // whether an account exists.
    try {
      await authClient.requestPasswordReset({ email: formData.email });
    } catch {
    } finally {
      setSubmitted(true);
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4 sm:p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md"
      >
        <Link
          href="/login"
          className="inline-flex items-center gap-2 text-gray-600 hover:text-blue-600 transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Sign In
        </Link>

        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <AuthBrandMark />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {submitted ? "Check Your Email" : "Forgot Password?"}
          </h1>
          {!submitted && (
            <p className="text-gray-600">
              Enter your email and we&apos;ll send you a reset link
            </p>
          )}
        </div>

        <div className="bg-white rounded-3xl shadow-xl border border-gray-100 p-6 sm:p-8">
          {submitted ? (
            <p className="text-gray-600 text-center">
              If an account exists for that address, a password reset link is on
              its way. The link expires in 1 hour.
            </p>
          ) : (
            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              <FormInput
                id="email"
                name="email"
                label="Email Address"
                type="email"
                placeholder="Enter your email"
                value={formData.email}
                error={fieldErrors.email}
                icon={<Mail className="h-5 w-5 text-gray-400" />}
                onChange={handleFieldChange}
                autoComplete="email"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-linear-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:shadow-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? "Sending..." : "Send Reset Link"}
                {!isLoading && <ArrowRight className="h-5 w-5" />}
              </button>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default ForgotPasswordPage;
