"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { CheckCircle, XCircle, Mail, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function VerificationUI() {
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [message, setMessage] = useState("");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  useEffect(() => {
    const verifyEmail = async () => {
      if (!token) {
        setStatus("error");
        setMessage("Invalid verification link. No token provided.");
        return;
      }

      try {
        const { error } = await authClient.verifyEmail({ query: { token } });

        if (error) {
          setStatus("error");
          setMessage(
            "This link is invalid or has expired. Sign in with your password and we'll email you a new one."
          );
        } else {
          setStatus("success");
          setMessage("Your email has been successfully verified.");
        }
      } catch {
        setStatus("error");
        setMessage(
          "Something went wrong. Please check your connection and try again."
        );
      }
    };

    verifyEmail();
  }, [token]);

  // The actual JSX for displaying the status
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md"
      >
        <div className="bg-white rounded-3xl shadow-xl border border-gray-100 p-8 text-center">
          {/* Status Icon */}
          <div className="mb-6">
            {status === "loading" && (
              <div className="inline-flex p-4 bg-blue-100 rounded-full">
                <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
              </div>
            )}
            {status === "success" && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring" }}
                className="inline-flex p-4 bg-green-100 rounded-full"
              >
                <CheckCircle className="h-8 w-8 text-green-600" />
              </motion.div>
            )}
            {status === "error" && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring" }}
                className="inline-flex p-4 bg-red-100 rounded-full"
              >
                <XCircle className="h-8 w-8 text-red-600" />
              </motion.div>
            )}
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            {status === "loading" && "Verifying Your Email..."}
            {status === "success" && "Email Verified!"}
            {status === "error" && "Verification Failed"}
          </h1>

          {/* Message */}
          <p className="text-gray-600 mb-8">{message || "Please wait..."}</p>

          {/* Action Buttons */}
          {status === "success" && (
            <Link href="/document-analysis">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:shadow-xl transition-all duration-300 flex items-center justify-center gap-2"
              >
                Start Analyzing <ArrowRight className="h-5 w-5" />
              </motion.button>
            </Link>
          )}

          {status === "error" && (
            <div className="space-y-3">
              <Link href="/login">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:shadow-xl transition-all duration-300 flex items-center justify-center gap-2"
                >
                  Sign In <Mail className="h-5 w-5" />
                </motion.button>
              </Link>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
