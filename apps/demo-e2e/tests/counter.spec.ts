import { expect, test } from "@playwright/test";

test("increments the counter on click", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cameri Demo" })).toBeVisible();

  const button = page.getByRole("button", { name: "Count: 0" });
  await button.click();
  await expect(page.getByRole("button")).toHaveText("Count: 1");
});
