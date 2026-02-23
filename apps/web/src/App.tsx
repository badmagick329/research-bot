import { RouterProvider } from "react-router-dom";
import { router } from "./router";

/**
 * Renders one router boundary so route-level feature slices can evolve independently in later phases.
 */
export function App() {
  return <RouterProvider router={router} />;
}
