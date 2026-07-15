import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "FB:TERMINAL · 한국어 금융 터미널",
  description: "출처, 기준 시각, Data Freshness와 License Scope를 정직하게 표시하는 한국어 금융 터미널",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
