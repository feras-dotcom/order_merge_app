import { json, redirect } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";
import { getLocationAccess } from "../lib/location-access.server";
import {
  isValidMergeWindow,
  missingOnboardingRequirements,
  SAFETY_RULES,
  WHAT_HAPPENS,
  type OnboardingRequirement,
} from "../lib/onboarding";
import { MergeWindowField } from "../components/MergeWindowField";
import { StatusDot } from "../components/StatusDot";
import { useLocationAccessRequest } from "../components/useLocationAccessRequest";

// ── Loader ────────────────────────────────────────────────
// Access is gated in app.tsx: incomplete setup always lands here; completed
// setup only reaches the final "done" step.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const [settings, locationAccess] = await Promise.all([
    getSettings(session.shop),
    getLocationAccess(admin, scopes, session.shop),
  ]);
  return json({
    done: new URL(request.url).searchParams.get("step") === "done",
    started: settings.onboardingStartedAt !== null,
    mergeWindowHours: settings.mergeWindowHours,
    locationAccess,
  });
};

// ── Action ────────────────────────────────────────────────

type ActionResult = { ok: boolean; intent: string; missing?: OnboardingRequirement[]; error?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  // Plain Remix redirects: this action is only reached by in-app fetcher
  // submissions, and the Shopify redirect helper would copy the request's
  // query string (including Remix's internal _data param) onto the target.
  const { admin, session, scopes } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const current = await getSettings(shop);

  if (current.onboardingCompletedAt) throw redirect("/app");

  if (intent === "start") {
    await upsertSettings(shop, { onboardingStartedAt: current.onboardingStartedAt ?? new Date() });
    return json<ActionResult>({ ok: true, intent });
  }

  const mergeWindowHours = Number(form.get("mergeWindowHours"));

  if (intent === "window") {
    if (!isValidMergeWindow(mergeWindowHours)) {
      return json<ActionResult>({ ok: false, intent, missing: ["merge-window"] }, { status: 400 });
    }
    await upsertSettings(shop, { mergeWindowHours });
    return json<ActionResult>({ ok: true, intent });
  }

  if (intent === "complete") {
    // Re-verify everything server-side against live Shopify state: the UI's
    // copy of it may be stale (e.g. location access revoked mid-setup).
    const location = await getLocationAccess(admin, scopes, shop);
    const missing = missingOnboardingRequirements({
      mergeWindowHours,
      location,
      acknowledged: form.get("acknowledged") === "true",
    });
    if (missing.length) {
      return json<ActionResult>({ ok: false, intent, missing }, { status: 400 });
    }
    const now = new Date();
    await upsertSettings(shop, {
      mergeWindowHours,
      autoMergeEnabled: true,
      autoMergeAcknowledgedAt: now,
      onboardingStartedAt: current.onboardingStartedAt ?? now,
      onboardingCompletedAt: now,
    });
    throw redirect("/app/onboarding?step=done");
  }

  return json<ActionResult>({ ok: false, intent, error: "Unknown request." }, { status: 400 });
};

// ── Component ─────────────────────────────────────────────

type Step = "welcome" | "window" | "location" | "safety" | "activate";

const SETUP_PREVIEW = [
  "choose how long MergeShip should look for repeat orders",
  "confirm fulfillment-location access if your store requires it",
  "review the safety protections before enabling automation",
];

const REQUIREMENT_MESSAGES: Record<OnboardingRequirement, string> = {
  "merge-window": "Choose a merge window.",
  location: "Location access is needed before MergeShip can be turned on.",
  acknowledgement: "Confirm you understand what happens when orders are combined.",
};

function StepCard({
  counter,
  title,
  children,
  back,
  primary,
}: {
  counter?: string;
  title: string;
  children: ReactNode;
  back?: () => void;
  primary: ReactNode;
}) {
  return (
    <Card>
      <BlockStack gap="500">
        <BlockStack gap="200">
          {counter && (
            <Text as="p" variant="bodySm" tone="subdued">
              {counter}
            </Text>
          )}
          <Text as="h2" variant="headingLg">
            {title}
          </Text>
        </BlockStack>
        {children}
        <InlineStack align={back ? "space-between" : "end"} blockAlign="center">
          {back && (
            <Button variant="plain" onClick={back}>
              Back
            </Button>
          )}
          {primary}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function OnboardingPage() {
  const { done, started, mergeWindowHours, locationAccess } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const { request: requestLocationAccess, requesting } = useLocationAccessRequest();

  const needsLocationStep = locationAccess.requirement !== "not-needed";
  const steps = useMemo<Step[]>(
    () => ["window", ...(needsLocationStep ? (["location"] as Step[]) : []), "safety", "activate"],
    [needsLocationStep],
  );

  const [step, setStep] = useState<Step>(started ? "window" : "welcome");
  const [windowHours, setWindowHours] = useState<number | null>(mergeWindowHours);
  const [acknowledged, setAcknowledged] = useState(false);

  // If completing fails server-side, jump to the first unmet requirement.
  const failure = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  useEffect(() => {
    if (!failure?.missing?.length) return;
    const first = failure.missing[0];
    setStep(first === "merge-window" ? "window" : first === "location" ? "location" : "activate");
  }, [failure]);

  const go = (offset: number) => setStep(steps[steps.indexOf(step) + offset]);
  const counter = step === "welcome" ? undefined : `Step ${steps.indexOf(step) + 1} of ${steps.length}`;
  const submitting = fetcher.state !== "idle";

  const errorBanner = failure?.missing?.length ? (
    <Banner tone="critical" title="MergeShip couldn't be turned on yet">
      <List type="bullet">
        {failure.missing.map((m) => (
          <List.Item key={m}>{REQUIREMENT_MESSAGES[m]}</List.Item>
        ))}
      </List>
    </Banner>
  ) : failure ? (
    <Banner tone="critical" title="Something went wrong">
      <p>{failure.error ?? "Please try again."}</p>
    </Banner>
  ) : null;

  if (done) {
    return (
      <Page narrowWidth>
        <TitleBar title="MergeShip" />
        <Box paddingBlockStart={{ xs: "0", md: "1000" }}>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <StatusDot on label="Automatic merging on" />
                <Text as="h2" variant="headingLg">
                  You're ready.
                </Text>
                <Text as="p" tone="subdued">
                  MergeShip is now watching for eligible repeat orders.
                </Text>
              </BlockStack>
              <InlineStack align="end">
                <Button variant="primary" url="/app">
                  Go to dashboard
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Box>
      </Page>
    );
  }

  return (
    <Page narrowWidth>
      <TitleBar title="Set up MergeShip" />
      {/* Offset from the top on larger screens so setup sits deliberately in
          the canvas instead of hugging the header; steps share the offset so
          the card doesn't jump between steps. */}
      <Box paddingBlockStart={{ xs: "0", md: "1000" }}>
        <BlockStack gap="400">
          {errorBanner}

          {step === "welcome" && (
            <Card padding={{ xs: "400", sm: "800" }}>
              <BlockStack gap="600">
                <BlockStack gap="300">
                  <Text as="h1" variant="headingXl">
                    Welcome to MergeShip
                  </Text>
                  <Text as="p" variant="bodyLg">
                    Repeat orders shouldn't mean more manual work.
                  </Text>
                  <Text as="p" tone="subdued">
                    Set up MergeShip in about a minute.
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" fontWeight="medium">
                    You'll:
                  </Text>
                  <List type="bullet">
                    {SETUP_PREVIEW.map((line) => (
                      <List.Item key={line}>{line}</List.Item>
                    ))}
                  </List>
                </BlockStack>
                <InlineStack align="start">
                  <Button
                    variant="primary"
                    size="large"
                    onClick={() => {
                      fetcher.submit({ intent: "start" }, { method: "post" });
                      setStep("window");
                    }}
                  >
                    Set up MergeShip
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          )}

          {step === "window" && (
            <StepCard
              counter={counter}
              title="Choose a merge window"
              primary={
                <Button
                  variant="primary"
                  disabled={windowHours === null}
                  onClick={() => {
                    fetcher.submit({ intent: "window", mergeWindowHours: String(windowHours) }, { method: "post" });
                    go(1);
                  }}
                >
                  Continue
                </Button>
              }
            >
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  MergeShip only combines repeat orders placed within this time
                  of each other. You can change it later in Settings.
                </Text>
                <MergeWindowField initialHours={windowHours ?? mergeWindowHours} onChange={setWindowHours} />
              </BlockStack>
            </StepCard>
          )}

        {step === "location" && (
          <StepCard
            counter={counter}
            title="Confirm fulfillment locations"
            back={() => go(-1)}
            primary={
              locationAccess.requirement === "needs-access" ? (
                <Button variant="primary" onClick={requestLocationAccess} loading={requesting}>
                  Allow location access
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => go(1)}
                  disabled={locationAccess.requirement !== "granted"}
                >
                  Continue
                </Button>
              )
            }
          >
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Your store has{" "}
                {locationAccess.activeLocationCount ?? "more than one"} active
                locations. MergeShip needs read-only location access so it can
                make sure repeat orders are fulfilled from the same place.
              </Text>
              {locationAccess.requirement === "granted" && (
                <StatusDot on label="Location access allowed" />
              )}
              {locationAccess.requirement === "unknown" && (
                <InlineStack gap="300" blockAlign="center">
                  <Text as="p" tone="subdued">
                    MergeShip couldn't check your store's locations.
                  </Text>
                  <Button variant="plain" onClick={() => revalidator.revalidate()}>
                    Check again
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </StepCard>
        )}

        {step === "safety" && (
          <StepCard
            counter={counter}
            title="How MergeShip keeps orders safe"
            back={() => go(-1)}
            primary={
              <Button variant="primary" onClick={() => go(1)}>
                Continue
              </Button>
            }
          >
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                MergeShip only combines orders when it can verify they're safe
                to combine. Anything that doesn't clearly qualify is left
                untouched. These protections are always on.
              </Text>
              <Text as="p">MergeShip only combines orders when:</Text>
              <List type="bullet">
                {SAFETY_RULES.map((rule) => (
                  <List.Item key={rule}>{rule}</List.Item>
                ))}
              </List>
            </BlockStack>
          </StepCard>
        )}

        {step === "activate" && (
          <StepCard
            counter={counter}
            title="Ready to turn on automatic merging?"
            back={() => go(-1)}
            primary={
              <Button
                variant="primary"
                disabled={!acknowledged}
                loading={submitting}
                onClick={() =>
                  fetcher.submit(
                    { intent: "complete", mergeWindowHours: String(windowHours), acknowledged: String(acknowledged) },
                    { method: "post" },
                  )
                }
              >
                Turn on MergeShip
              </Button>
            }
          >
            <BlockStack gap="400">
              <Text as="p" tone="subdued">
                MergeShip will automatically combine repeat orders that pass
                all safety checks. Orders that don't clearly qualify will stay
                untouched.
              </Text>
              <BlockStack gap="200">
                <Text as="p">When two orders are combined:</Text>
                <List type="bullet">
                  {WHAT_HAPPENS.map((line) => (
                    <List.Item key={line}>{line}</List.Item>
                  ))}
                </List>
              </BlockStack>
              <Checkbox
                label="I understand MergeShip will move items onto the earlier order, cancel the newer order, and won't refund its shipping."
                checked={acknowledged}
                onChange={setAcknowledged}
              />
            </BlockStack>
          </StepCard>
        )}
        </BlockStack>
      </Box>
    </Page>
  );
}
