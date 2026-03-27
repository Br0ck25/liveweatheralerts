import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: "/",
      element: <AppShell />,
      children: [
        {
          index: true,
          element: <></>
        },
        {
          path: "alerts",
          element: <></>
        },
        {
          path: "alerts/:alertId",
          element: <></>
        },
        {
          path: "history",
          element: <></>
        },
        {
          path: "forecast",
          element: <></>
        },
        {
          path: "settings",
          element: <></>
        },
        {
          path: "*",
          element: <Navigate to="/alerts" replace />
        }
      ]
    }
  ]);
}

export const appRouter = createAppRouter();
