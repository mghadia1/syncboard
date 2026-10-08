import { COLORS, type Color } from "@syncboard/shared";
import { Icon } from "./icons";
import { COLOR_NAMES, TOOLS, type Tool } from "./tools";

export type ToolbarProps = {
  tool: Tool;
  color: Color;
  filled: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  hasSelection: boolean;
  onTool: (tool: Tool) => void;
  onColor: (color: Color) => void;
  onFill: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFront: () => void;
  onBack: () => void;
  onDelete: () => void;
};

const mod = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * The marker tray along the bottom of the board: tools, then the markers
 * (each color drawn as a marker cap; the chosen one is lifted), fill,
 * undo and redo, and what can be done to the selection.
 */
export function Toolbar(props: ToolbarProps) {
  return (
    <div className="tray" role="toolbar" aria-label="Drawing tools">
      <div className="tray-group">
        {TOOLS.map(({ tool, label, key }) => (
          <button
            key={tool}
            type="button"
            className="tray-button"
            aria-pressed={props.tool === tool}
            aria-label={label}
            title={`${label} (${key.toUpperCase()})`}
            onClick={() => {
              props.onTool(tool);
            }}
          >
            <Icon name={tool} />
          </button>
        ))}
      </div>
      <div className="tray-group markers" aria-label="Color" role="group">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="marker"
            data-color={color}
            aria-pressed={props.color === color}
            aria-label={COLOR_NAMES[color]}
            title={COLOR_NAMES[color]}
            onClick={() => {
              props.onColor(color);
            }}
          >
            <span className="marker-cap" aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          className="tray-button fill-toggle"
          aria-pressed={props.filled}
          title="Fill shapes with a tint of the color"
          onClick={props.onFill}
        >
          Fill
        </button>
      </div>
      <div className="tray-group">
        <button
          type="button"
          className="tray-button"
          aria-label={props.undoLabel ? `Undo ${props.undoLabel}` : "Undo"}
          title={`Undo${props.undoLabel ? ` ${props.undoLabel}` : ""} (${mod}Z)`}
          disabled={props.undoLabel === null}
          onClick={props.onUndo}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="tray-button"
          aria-label={props.redoLabel ? `Redo ${props.redoLabel}` : "Redo"}
          title={`Redo${props.redoLabel ? ` ${props.redoLabel}` : ""} (${mod}Shift+Z)`}
          disabled={props.redoLabel === null}
          onClick={props.onRedo}
        >
          <Icon name="redo" />
        </button>
      </div>
      {props.hasSelection && (
        <div className="tray-group">
          <button type="button" className="tray-button" aria-label="Bring to front" title="Bring to front (])" onClick={props.onFront}>
            <Icon name="front" />
          </button>
          <button type="button" className="tray-button" aria-label="Send to back" title="Send to back ([)" onClick={props.onBack}>
            <Icon name="back" />
          </button>
          <button type="button" className="tray-button" aria-label="Delete" title="Delete (Delete)" onClick={props.onDelete}>
            <Icon name="trash" />
          </button>
        </div>
      )}
    </div>
  );
}
