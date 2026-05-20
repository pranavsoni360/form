"use client";

import * as React from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Sentry event id from the last capture — used for the "Copy details" button */
  sentryEventId: string | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback UI override */
  fallback?: (state: ErrorBoundaryState, reset: () => void) => React.ReactNode;
}

/**
 * Route-level error boundary. Catches render errors, surfaces a friendly
 * fallback, and routes the exception to Sentry if it's loaded.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, sentryEventId: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // No-op if Sentry's DSN wasn't set — Sentry.init() returns early in that
    // case and captureException still produces an id (or undefined) without
    // throwing. Safe to call unconditionally.
    try {
      const id = Sentry.captureException(error, {
        contexts: { react: { componentStack: info.componentStack ?? "" } },
      });
      this.setState({ sentryEventId: id ?? null });
    } catch {
      // Ignore — UI is still useful without an event id
    }
  }

  reset = () => this.setState({ hasError: false, error: null, sentryEventId: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state, this.reset);

    const msg = this.state.error?.message ?? "Unknown error";
    return (
      <div className="grid min-h-[60vh] place-items-center px-6">
        <Card className="max-w-lg">
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-destructive/15">
                <AlertTriangle className="h-4 w-4 text-destructive" />
              </span>
              <div>
                <CardTitle>Something went wrong</CardTitle>
                <CardDescription>
                  We&apos;ve logged the error — try reloading the section.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
              {msg}
            </div>
            {this.state.sentryEventId && (
              <div className="text-[11px] text-muted-foreground">
                Event ID: <span className="font-mono">{this.state.sentryEventId}</span>
              </div>
            )}
            <Button onClick={this.reset} variant="default" size="sm">
              <RefreshCw className="h-3.5 w-3.5" />
              Reload section
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}
