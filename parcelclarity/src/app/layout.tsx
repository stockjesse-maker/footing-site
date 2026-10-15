import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ParcelClarity", template: "%s · ParcelClarity" },
  description: "Know what fulfillment and shipping will cost before you ship.",
  applicationName: "ParcelClarity",
  appleWebApp: { capable: true, title: "ParcelClarity", statusBarStyle: "default" },
  formatDetection: { telephone: false, email: false, address: false },
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }] },
  robots: { index: false, follow: false }, // customer portal: nothing here should be indexed
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
