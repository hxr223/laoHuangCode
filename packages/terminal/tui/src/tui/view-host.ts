import type { FocusableComponent } from "./component.ts";
import { createModalOverlay, createSelectorOverlay } from "./components.ts";
import { AuthDialog } from "./components/views/auth-dialog.ts";
import type { PromptRequest, SelectionRequest } from "./components/views/contracts.ts";
import {
  EffortSelectorView,
  ProviderSelectorView,
} from "./components/views/effort-selector.ts";
import { ModelSelectorView } from "./components/views/model-selector.ts";
import { OverlayManager } from "./overlay-manager.ts";
import type { RenderContext, ComponentRenderResult } from "./render-model.ts";
import type { TuiInputEvent } from "../keybindings/key-id.ts";

interface ActiveView<T> {
  readonly id: string;
  readonly component: FocusableComponent;
  readonly resolve: (value: T | null) => void;
}

/** Owns the lifecycle and Promise result for focused transient views. */
export class ViewHost {
  readonly #overlays: OverlayManager;
  #views: ActiveView<string>[] = [];

  constructor(overlays: OverlayManager) {
    this.#overlays = overlays;
  }

  openSelection(request: SelectionRequest): Promise<string | null> {
    return new Promise((resolve) => {
      const component = this.#selectionComponent(request);
      this.#open({ id: request.id, component, resolve }, "selector");
    });
  }

  openPrompt(request: PromptRequest): Promise<string | null> {
    return new Promise((resolve) => {
      const component = new AuthDialog({
        request,
        onSubmit: (value) => this.#close(request.id, value),
        onCancel: () => this.#close(request.id, null),
      });
      this.#open({ id: request.id, component, resolve }, "modal");
    });
  }

  handleInput(event: TuiInputEvent): boolean {
    return this.#topView()?.component.handleInput?.(event) ?? false;
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#topView()?.component.render(context) ?? { lines: [] };
  }

  closeActive(value: string | null): void {
    const active = this.#topView();
    if (active !== undefined) {
      this.#close(active.id, value);
    }
  }

  closeAll(): void {
    for (const view of [...this.#views]) {
      this.#close(view.id, null);
    }
  }

  activeId(): string | null {
    return this.#topView()?.id ?? null;
  }

  #open(view: ActiveView<string>, priority: "selector" | "modal"): void {
    this.#close(view.id, null);
    this.#views.push(view);
    if (priority === "selector") {
      this.#overlays.open(createSelectorOverlay(view.id, view.component));
    } else {
      this.#overlays.open(createModalOverlay(view.id, view.component));
    }
  }

  #close(id: string, value: string | null): void {
    const views = this.#views.filter((view) => view.id === id);
    if (views.length === 0) {
      return;
    }
    this.#views = this.#views.filter((view) => view.id !== id);
    for (const view of views) {
      view.component.dispose?.();
    }
    this.#overlays.close(id);
    for (const view of views) {
      view.resolve(value);
    }
  }

  #topView(): ActiveView<string> | undefined {
    const activeId = this.#overlays.top()?.id;
    for (let index = this.#views.length - 1; index >= 0; index -= 1) {
      const view = this.#views[index];
      if (view !== undefined && view.id === activeId) {
        return view;
      }
    }
    return undefined;
  }

  #selectionComponent(request: SelectionRequest): FocusableComponent {
    const options = {
      ...request,
      onSelect: (value: string) => this.#close(request.id, value),
      onCancel: () => this.#close(request.id, null),
    };
    if (request.id === "model") {
      return new ModelSelectorView(options);
    }
    if (request.id === "provider") {
      return new ProviderSelectorView(options);
    }
    return new EffortSelectorView(options);
  }
}
