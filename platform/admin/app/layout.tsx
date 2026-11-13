import type { ReactNode } from "react";
import "./style.css";
export const metadata = { title: "Coursera Queue — кабинет", description: "Лицензии и управление доступом" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="ru"><body><main>{children}</main></body></html>;
}
