"use client";

import { Sidebar } from "@/components/layout/Sidebar";
import DataProvider from "@/components/layout/DataProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <DataProvider>
        <div className="flex min-h-screen bg-gray-50">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </DataProvider>
    </TooltipProvider>
  );
}
