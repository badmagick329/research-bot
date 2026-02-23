import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "./layouts/AppShell";
import { EnqueueRoute } from "./routes/EnqueueRoute";
import { RunMonitorRoute } from "./routes/RunMonitorRoute";
import { SnapshotRoute } from "./routes/SnapshotRoute";

/**
 * Defines stable top-level routes now so feature work in Phase 4 can focus on per-route logic only.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      {
        index: true,
        element: <EnqueueRoute />,
      },
      {
        path: "runs",
        element: <RunMonitorRoute />,
      },
      {
        path: "snapshots",
        element: <SnapshotRoute />,
      },
    ],
  },
]);
