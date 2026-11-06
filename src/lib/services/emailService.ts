import nodemailer from 'nodemailer';
import { escapeHtml } from '@/lib/utils/html';

const createTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
};

const getAppUrl = () => {
    const appUrl = process.env.BETTER_AUTH_URL;
    if (!appUrl) {
        throw new Error('BETTER_AUTH_URL is not set; cannot build email links');
    }
    return appUrl;
};

export const sendVerificationEmail = async (email: string, token: string, name: string) => {
    const transporter = createTransporter();

    const verificationUrl = `${getAppUrl()}/verify-email?token=${token}`;

    const mailOptions = {
        from: {
            name: 'Legalyze AI',
            address: process.env.EMAIL_USER!
        },
        to: email,
        subject: 'Verify Your Email - Legalyze AI',
        html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background-color: white; }
          .header { background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 40px 20px; text-align: center; }
          .logo { width: 60px; height: 60px; background-color: white; border-radius: 12px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; }
          .content { padding: 40px 20px; }
          .button { display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; margin: 20px 0; }
          .footer { padding: 20px; text-align: center; color: #64748b; font-size: 14px; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">⚖️</div>
            <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to Legalyze AI</h1>
          </div>
          <div class="content">
            <h2 style="color: #1e293b; margin-bottom: 20px;">Hi ${escapeHtml(name)},</h2>
            <p style="color: #475569; line-height: 1.6; margin-bottom: 20px;">
              Thank you for signing up for Legalyze AI! We're excited to have you on board.
            </p>
            <p style="color: #475569; line-height: 1.6; margin-bottom: 30px;">
              To complete your registration and start analyzing legal documents with AI, please verify your email address by clicking the button below:
            </p>
            <div style="text-align: center;">
              <a href="${verificationUrl}" class="button">Verify Email Address</a>
            </div>
            <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
              If you didn't create an account with us, please ignore this email.
            </p>
            <p style="color: #64748b; font-size: 14px;">
              This verification link will expire in 24 hours for security reasons.
            </p>
          </div>
          <div class="footer">
            <p>© 2025 Legalyze AI. All rights reserved.</p>
            <p>This is an automated email, please do not reply.</p>
          </div>
        </div>
      </body>
      </html>
    `
    };

    await transporter.sendMail(mailOptions);
};

export const sendPasswordResetEmail = async (email: string, token: string, name: string) => {
    const transporter = createTransporter();

    const resetUrl = `${getAppUrl()}/reset-password?token=${token}`;

    const mailOptions = {
        from: {
            name: 'Legalyze AI',
            address: process.env.EMAIL_USER!
        },
        to: email,
        subject: 'Reset Your Password - Legalyze AI',
        html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background-color: white; }
          .header { background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 40px 20px; text-align: center; }
          .logo { width: 60px; height: 60px; background-color: white; border-radius: 12px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; }
          .content { padding: 40px 20px; }
          .button { display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 12px; font-weight: 600; margin: 20px 0; }
          .footer { padding: 20px; text-align: center; color: #64748b; font-size: 14px; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">⚖️</div>
            <h1 style="color: white; margin: 0; font-size: 28px;">Password Reset</h1>
          </div>
          <div class="content">
            <h2 style="color: #1e293b; margin-bottom: 20px;">Hi ${escapeHtml(name)},</h2>
            <p style="color: #475569; line-height: 1.6; margin-bottom: 20px;">
              We received a request to reset your password for your Legalyze AI account.
            </p>
            <p style="color: #475569; line-height: 1.6; margin-bottom: 30px;">
              Click the button below to reset your password:
            </p>
            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">Reset Password</a>
            </div>
            <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
              If you didn't request a password reset, please ignore this email. Your password will remain unchanged.
            </p>
            <p style="color: #64748b; font-size: 14px;">
              This password reset link will expire in 1 hour for security reasons.
            </p>
          </div>
          <div class="footer">
            <p>© 2025 Legalyze AI. All rights reserved.</p>
            <p>This is an automated email, please do not reply.</p>
          </div>
        </div>
      </body>
      </html>
    `
    };

    await transporter.sendMail(mailOptions);
};