import { NavLink, Outlet } from "react-router-dom";

/**
 * Provides a minimal operator shell so all workflow views share consistent navigation and framing.
 */
export function AppShell() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">
            Research Bot Ops Console
          </h1>
          <nav className="flex items-center gap-4 text-sm">
            <NavItem to="/">Enqueue</NavItem>
            <NavItem to="/runs">Run Monitor</NavItem>
            <NavItem to="/snapshots">Snapshot</NavItem>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

type NavItemProps = {
  to: string;
  children: string;
};

/**
 * Uses active-link styling to keep route context obvious for operators switching between workflows.
 */
function NavItem({ to, children }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        isActive
          ? "rounded-md bg-slate-700 px-3 py-1.5 font-medium text-white"
          : "rounded-md px-3 py-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
      }
      end={to === "/"}
    >
      {children}
    </NavLink>
  );
}
