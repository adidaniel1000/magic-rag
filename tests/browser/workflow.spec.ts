import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
test("onboarding, cancelled picker, indexing, search, configuration preview and responsive UI", async ({
  page,
}) => {
  const setup = JSON.parse(
    await fs.readFile(".secondmind-test/ui-bootstrap.json", "utf8"),
  );
  await page.goto(setup.url);
  await expect(page.getByText("Start with one folder.")).toBeVisible();
  await page
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  await expect(page.getByLabel("Folder path")).toHaveValue("");
  await page.screenshot({
    path: "artifacts/library-empty.png",
    fullPage: true,
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secondmind-ui-docs-"));
  await fs.writeFile(
    path.join(root, "leave.md"),
    "# Parent leave\n\nParental leave is sixteen weeks for new parents.",
  );
  await page.getByLabel("Folder path").fill(root);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(
    page.getByText("1 indexed · 1 discovered · 0 issues"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  await page.getByLabel("Your question").fill("parent leave");
  await page.getByRole("button", { name: "Search knowledge" }).click();
  await expect(
    page.getByRole("heading", { name: "1 sources found" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Parent leave", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/playground.png", fullPage: true });
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const localConnection = page.getByRole("region", {
    name: "Local HTTP connection",
  });
  await expect(localConnection).toContainText(
    new URL(setup.url).origin + "/mcp",
  );
  await expect(localConnection).toContainText("No sign-in or token is needed.");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .getByRole("button", { name: "Copy local address", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    new URL(setup.url).origin + "/mcp",
  );
  await page.screenshot({ path: "artifacts/connections.png", fullPage: true });
  await page
    .getByRole("button", { name: "Preview connection" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("secondmind");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Start tunnel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("hostname");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/library-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
