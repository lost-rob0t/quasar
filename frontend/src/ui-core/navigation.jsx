import {
  Bot,
  Code2,
  FilePlus2,
  FolderInput,
  House,
  Layers3,
  Network,
  Search,
  Settings
} from "lucide-react";

export const navigation = Object.freeze([
  { to: "/", label: "Home", mobileLabel: "Home", Icon: House, match: (path) => path === "/" },
  {
    to: "/graph",
    label: "Graphs",
    mobileLabel: "Graph",
    Icon: Network,
    match: (path) => path === "/graph" || path.startsWith("/graph/")
  },
  {
    to: "/datasets",
    label: "Datasets",
    mobileLabel: "Data",
    Icon: Layers3,
    match: (path) => path === "/datasets" || path.startsWith("/datasets/")
  },
  {
    to: "/documents",
    label: "Documents",
    mobileLabel: "Docs",
    Icon: Search,
    match: (path) =>
      path === "/documents" || (path.startsWith("/documents/") && path !== "/documents/new")
  },
  {
    to: "/documents/new",
    label: "Add document",
    Icon: FilePlus2,
    match: (path) => path === "/documents/new"
  },
  {
    to: "/agents",
    label: "Agents",
    mobileLabel: "Agents",
    Icon: Bot,
    match: (path) => path === "/agents"
  },
  { to: "/actors", label: "Actors", Icon: Code2, match: (path) => path === "/actors" },
  { to: "/import", label: "Import", Icon: FolderInput, match: (path) => path === "/import" },
  {
    to: "/settings",
    label: "Settings",
    mobileLabel: "Settings",
    Icon: Settings,
    match: (path) => path === "/settings"
  }
]);

export function activeNavigationItem(pathname) {
  return navigation.find((item) => item.match(pathname)) || null;
}
