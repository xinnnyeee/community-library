import { lazy } from "react";
import Book from "@/Book";
import Canvas from "@/Canvas";
import { ThemeProvider } from "@/components/theme-provider";
import { DataCacheProvider } from "@/contexts/DataCacheContext";
import { client } from "@/lib/api-client";
import { extractIdFromSlug } from "@/lib/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";

const MiniApp = lazy(() => import("@/routes/MiniApp"));
const AddBook = lazy(() => import("@/routes/AddBook"));
const AddBookCover = lazy(() => import("@/routes/AddBookCover"));
const ManageBooks = lazy(() => import("@/routes/ManageBooks"));

// React Query client for data fetching
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

// In-memory cache for Canvas data loader
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const canvasCache = new Map<string, any>();
const CANVAS_CACHE_KEY = "canvas-books";

const router = createBrowserRouter([
  {
    path: "/",
    loader: async () => {
      // Check cache first
      const cachedData = canvasCache.get(CANVAS_CACHE_KEY);
      if (cachedData) {
        return cachedData;
      }

      const res = await client.api.books.$get();
      if (!res.ok) {
        throw new Error("Failed to fetch books");
      }
      const data = await res.json();
      const result = { books: data.books };

      canvasCache.set(CANVAS_CACHE_KEY, result);
      return result;
    },
    Component: Canvas,
  },
  {
    path: "/book/:slug",
    loader: async ({ params }) => {
      const slug = params.slug;
      if (!slug) {
        throw new Error("Slug is required");
      }
      const id = extractIdFromSlug(slug);

      if (!id) {
        throw new Error("Invalid book URL");
      }

      const res = await client.api.books[":id"].$get({
        param: { id },
      });

      if (!res.ok) {
        throw new Error("Book not found");
      }

      const data = await res.json();
      return { book: data.book };
    },
    Component: Book,
  },
  {
    path: "/mini-app",
    Component: MiniApp,
  },
  {
    path: "/admin/add-book",
    Component: AddBook,
  },
  {
    path: "/admin/add-book/cover/:isbn",
    Component: AddBookCover,
  },
  {
    path: "/admin/manage-books",
    Component: ManageBooks,
  },
]);

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system">
        <DataCacheProvider>
          <RouterProvider router={router} />
        </DataCacheProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
