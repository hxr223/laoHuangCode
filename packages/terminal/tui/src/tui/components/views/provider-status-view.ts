import type { TuiComponent } from "../../component.ts";
import {
  line,
  span,
  type ComponentRenderResult,
  type RenderContext,
  type SpanStyle,
  type StyledLine,
} from "../../render-model.ts";
import type { ProviderDetailViewModel, ProviderSummaryViewModel } from "./contracts.ts";

export interface ProviderStatusViewOptions {
  readonly providers: readonly ProviderSummaryViewModel[];
}

export class ProviderStatusView implements TuiComponent {
  readonly #providers: readonly ProviderSummaryViewModel[];

  constructor(options: ProviderStatusViewOptions) {
    this.#providers = options.providers;
  }

  render(context: RenderContext): ComponentRenderResult {
    return { lines: this.#providers.flatMap((provider) => renderProvider(provider, context.width)) };
  }

  invalidate(): void {}
}

export interface ProviderDetailViewOptions extends ProviderDetailViewModel {}

export class ProviderDetailView implements TuiComponent {
  readonly #provider: ProviderDetailViewModel;

  constructor(options: ProviderDetailViewOptions) {
    this.#provider = options;
  }

  render(context: RenderContext): ComponentRenderResult {
    const modelLabel = this.#provider.dynamicModels ? "dynamic models" : "static models";
    return {
      lines: [
        ...renderProvider(this.#provider, context.width),
        line(span(modelLabel), span(`  ${this.#provider.modelCount} ${this.#provider.modelCount === 1 ? "model" : "models"}`)),
      ],
    };
  }

  invalidate(): void {}
}

function renderProvider(provider: ProviderSummaryViewModel, width: number): readonly StyledLine[] {
  const states = providerStates(provider);
  const source = provider.source === null ? [] : [line(span(provider.source, { foreground: "muted" }))];
  if (width >= 50) {
    return [line(
      span(provider.name),
      ...states.flatMap((state) => [span("  "), span(state.text, state.style)]),
    ), ...source];
  }
  return [
    line(span(provider.name)),
    ...states.map((state) => line(span(state.text, state.style))),
    ...source,
  ];
}

function providerStates(provider: ProviderSummaryViewModel): readonly { readonly text: string; readonly style?: SpanStyle }[] {
  return [
    { text: provider.available ? "available" : "unavailable" },
    provider.configured
      ? { text: "configured", style: { foreground: "success" } }
      : { text: "unconfigured", style: { foreground: "warning" } },
    provider.verified
      ? { text: "verified", style: { foreground: "success" } }
      : { text: "unverified", style: { foreground: "warning" } },
  ];
}
