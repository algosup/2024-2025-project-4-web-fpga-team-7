import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Example, type IConnection } from "@/lib/types/types";
import CanvasActionBar from "./CanvasActionBar";
import { getTheme } from "../theme-provider";
import { useCanvasHistory } from "@/lib/services/canvas-history";
import { toast } from "sonner";
import { IElement } from "@/lib/types/types";

// Helper type for wire segments
type Point = {
  x: number;
  y: number;
};

// Add a type for signal propagation
type Signal = {
  connectionName: string;
  position: number; // 0-1 to represent progress along the wire (percentage)
  points: Point[]; // The path points this signal is following
  totalLength: number; // Total length of the path
  createdAt: number; // Timestamp when signal was created
  sourceName: string; // Name of source element
  destName: string; // Name of destination element
};

// Add a type for tracking flip-flop internal state
type FlipFlopState = {
  id: number;
  name: string;
  hasD: boolean; // Whether D input is active
  hasEn: boolean; // Whether En input is active (always true for DFF_NE)
  outputValue: boolean; // Current output value
  lastClockTime: number; // Last time clock was received
  type: string; // Store the flip-flop type for reference
};

// Function to get the specific port position for an element based on type and port name
const getPortPosition = (
  element: IElement,
  portType: "input" | "output",
  portName: string
): Point => {
  const size = 50;
  const x = element.x || 0;
  const y = element.y || 0;

  // Default positions (centered on sides)
  let portX = portType === "input" ? x : x + size;
  let portY = y + size / 2;

  // For flip-flops, position the ports according to their function
  if (element.type === "DFF" || element.type === "DFF_NE") {
    if (portType === "input") {
      // Different input positions based on port name
      if (portName.includes("D") || portName.endsWith("_0")) {
        // D input at the top-left (25% from top)
        portX = x;
        portY = y + size * 0.25;
      } else if (portName.includes("clk") || portName.endsWith("_1")) {
        // Clock input at the bottom-center
        portX = x + size / 2; // Center horizontally
        portY = y + size; // Bottom of element
      } else if (portName.includes("en") || portName.endsWith("_2")) {
        // Enable input at the bottom-left (75% from top)
        portX = x;
        portY = y + size * 0.75; // Make sure it's different from D input
      }
    } else {
      // Output Q is on the right side, centered
      portX = x + size;
      portY = y + size / 2;
    }
  }

  return { x: portX, y: portY };
};

// Function to calculate orthogonal path with corners
const calculateOrthogonalPath = (
  sourceElement: IElement,
  destElement: IElement,
  connection: IConnection
): Point[] => {
  // Find which port on the source element this connection comes from
  const  sourcePort = sourceElement.outputs?.find(
    (output) => output.wireName === connection.name
  );
 
  // Find which port on the destination element this connection goes to
  const  destPort = destElement.inputs?.find(
    (input) => input.wireName === connection.name
  );

  // Get port positions using the new helper function
  const sourcePos = getPortPosition(
    sourceElement,
    "output",
    sourcePort?.wireName || connection.name
  );

  const destPos = getPortPosition(
    destElement,
    "input",
    destPort?.wireName || connection.name
  );

  const startX = sourcePos.x;
  const startY = sourcePos.y;
  const endX = destPos.x;
  const endY = destPos.y;

  const path: Point[] = [];

  // Add the starting point
  path.push({ x: startX, y: startY });

  // Calculate the midpoint X
  const midX = startX + (endX - startX) / 2;

  // Add the first corner point
  path.push({ x: midX, y: startY });

  // Add the second corner point
  path.push({ x: midX, y: endY });

  // Add the end point
  path.push({ x: endX, y: endY });

  return path;
};

// Add a function to automatically arrange elements based on connections
const arrangeElements = (
  elements: IElement[],
  connections: IConnection[]
): IElement[] => {
  // Clone the elements to avoid modifying the original array
  const arrangedElements = [...elements];

  // If there are no elements, return empty array
  if (arrangedElements.length === 0) return arrangedElements;

  // Step 1: Create a dependency graph to determine element order
  const dependencyGraph: Record<number, number[]> = {};
  arrangedElements.forEach((el) => {
    dependencyGraph[el.id] = [];
  });

  // Add connections to dependency graph
  connections.forEach((conn) => {
    const sourceElement = arrangedElements.find(
      (el) =>
        el.outputs && el.outputs.some((output) => output.wireName === conn.name)
    );

    const destElement = arrangedElements.find(
      (el) =>
        el.inputs && el.inputs.some((input) => input.wireName === conn.name)
    );

    if (sourceElement && destElement) {
      // Add destination to source's dependencies
      dependencyGraph[sourceElement.id].push(destElement.id);
    }
  });

  // Step 2: Topological sort to determine layers of elements
  const visited = new Set<number>();
  const layers: number[][] = [];

  // First identify inputs, clocks, and sources (elements without inputs)
  const sourceLayers = arrangedElements
    .filter(
      (el) =>
        el.type === "module_input" ||
        el.type === "clk" ||
        !el.inputs ||
        el.inputs.length === 0
    )
    .map((el) => el.id);

  layers.push(sourceLayers);
  sourceLayers.forEach((id) => visited.add(id));

  // Breadth-first search to build the layers
  let currentLayer = sourceLayers;
  while (currentLayer.length > 0) {
    const nextLayer: number[] = [];

    // Find all elements that depend on the current layer
    currentLayer.forEach((srcId) => {
      dependencyGraph[srcId].forEach((destId) => {
        if (!visited.has(destId)) {
          // Check if all dependencies of this element are already visited
          const el = arrangedElements.find((e) => e.id === destId);
          if (el && el.inputs) {
            const inputElements = el.inputs
              .map((input) => {
                const source = arrangedElements.find(
                  (e) =>
                    e.outputs &&
                    e.outputs.some(
                      (output) => output.wireName === input.wireName
                    )
                );
                return source?.id;
              })
              .filter((id) => id !== undefined) as number[];

            // If all dependencies are visited, add to the next layer
            if (inputElements.every((id) => visited.has(id))) {
              nextLayer.push(destId);
              visited.add(destId);
            }
          }
        }
      });
    });

    if (nextLayer.length > 0) {
      layers.push(nextLayer);
    }

    currentLayer = nextLayer;
  }

  // Check for any remaining elements not in layers (possibly due to cycles)
  const remainingElements = arrangedElements
    .map((el) => el.id)
    .filter((id) => !visited.has(id));

  if (remainingElements.length > 0) {
    layers.push(remainingElements);
  }

  // Step 3: Assign positions to elements based on their layer
  const HORIZONTAL_SPACING = 200; // Space between layers
  const VERTICAL_SPACING = 100; // Space between elements in the same layer

  layers.forEach((layerIds, layerIndex) => {
    const layerX = 100 + layerIndex * HORIZONTAL_SPACING;

    layerIds.forEach((id, elementIndex) => {
      const layerY = 100 + elementIndex * VERTICAL_SPACING;

      // Find the element and update its position
      const elementToUpdate = arrangedElements.find((el) => el.id === id);
      if (elementToUpdate) {
        elementToUpdate.x = layerX;
        elementToUpdate.y = layerY;
      }
    });
  });

  return arrangedElements;
};

export default function SimulationCanvas({
  activeTabId,
  examples,
  playing,
  resetTriggered = false,
}: {
  activeTabId: string;
  examples: Example[];
  playing: boolean;
  resetTriggered?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [elements, setElements] = useState<IElement[]>([]);
  const [connections, setConnections] = useState<IConnection[]>([]);

  // Get theme inside component body
  const theme = getTheme();
  const isDarkTheme = theme === "dark";

  // Add a state variable for tracking if simulation is running
  const [runningSimulation, setRunningSimulation] = useState<boolean>(false);

  // Synchronize runningSimulation with the playing prop
  useEffect(() => {
    setRunningSimulation(playing);
  }, [playing]);

  const [zoomLevel, setZoomLevel] = useState<number>(1); // 1 = 100%
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Add state variables for dragging functionality
  const [draggingElement, setDraggingElement] = useState<number | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [elementWasDragged, setElementWasDragged] = useState(false);
  const [elementsModified, setElementsModified] = useState(false);

  // Add clock frequency state (default: 20Hz)
  const [clockFrequency, setClockFrequency] = useState<number>(20);

  // Calculate the interval time based on formula 1/(frequency*10)
  const signalSpeed = useMemo(() => {
    // Adjust speed to be consistent regardless of wire length
    return 1 / clockFrequency; // Time in seconds for full wire traversal
  }, [clockFrequency]);

  // Add state to track active signals on wires
  const [activeSignals, setActiveSignals] = useState<Signal[]>([]);

  // Add state for flip-flop internal values
  const [flipFlopStates, setFlipFlopStates] = useState<FlipFlopState[]>([]);

  // Add state to track which input elements are active
  const [activeInputs, setActiveInputs] = useState<number[]>([]);
  
  // Add state to track which output elements are active with their activation time
  const [activeOutputs, setActiveOutputs] = useState<{[id: number]: number}>({});

  // Add a state to keep track of the clicked element (for differentiating click vs drag)
  const [clickedElement, setClickedElement] = useState<IElement | null>(null);

  // Add a new state for storing preloaded images
  const [componentImages, setComponentImages] = useState<{
    [key: string]: HTMLImageElement;
  }>({});

  // Define a mapping of element types to image filenames
  const elementTypeToImageMap = useMemo(
    () => ({
      module_input: "module_input",
      module_input_en: "module_input_en",
      module_output: "module_output",
      module_output_en: "module_output_en",
      clk: "clk",
      DFF_NE: "DFF_noEn",
      DFF: "DFF_En",
      LUT1: "LUT_1",
      LUT2: "LUT_2",
      LUT3: "LUT_3",
      LUT4: "LUT_4",
      and: "and",
      nand: "nand",
      nor: "nor",
      nxor: "nxor",
      or: "or",
      xor: "xor",
    }),
    []
  );

  // Initialize the canvas history
  const { pushState, undo, redo, reset, canUndo, canRedo } = useCanvasHistory({
    elements: [],
    connections: [],
    elementPositions: new Map(),
  });

  // Add a new state to track active signals at each flip-flop input
  const [activeFlipFlopInputs, setActiveFlipFlopInputs] = useState<{
    [flipFlopId: number]: {
      D: boolean;
      En: boolean;
      lastEnUpdateTime: number;
    };
  }>({});

  // IMPORTANT: Define handleSignalArrival before it's used in useEffect hooks
  const handleSignalArrival = useCallback(
    (signal: Signal) => {
      // Find the destination element
      const destElement = elements.find(
        (el) =>
          el.inputs &&
          el.inputs.some((input) => input.wireName === signal.connectionName)
      );

      if (!destElement) return;

      // Get the input port this signal is connected to
      const inputPort = destElement.inputs?.find(
        (input) => input.wireName === signal.connectionName
      );
      if (!inputPort) return;

      // If this is a module_output, activate it
      if (destElement.type === "module_output") {
        setActiveOutputs(prev => ({
          ...prev,
          [destElement.id]: performance.now() // Record current time
        }));
      }

      // If this is a flip-flop, update its state
      if (destElement.type === "DFF" || destElement.type === "DFF_NE") {
        // Determine which input this signal is connected to
        const portIndex = destElement.inputs?.indexOf(inputPort);
        const isClockInput = portIndex === 1 || (inputPort.wireName && inputPort.wireName.includes("clk"));
        const isDInput = portIndex === 0 || (inputPort.wireName && inputPort.wireName.includes("D"));
        const isEnInput = portIndex === 2 || (inputPort.wireName && inputPort.wireName.includes("en"));
        
        setFlipFlopStates((prev) => {
          // Find the flip-flop state
          const ffIndex = prev.findIndex((ff) => ff.id === destElement.id);
          if (ffIndex === -1) return prev;

          const newStates = [...prev];
          const currentTime = performance.now();
          
          if (isDInput) {
            // Update D input state
            newStates[ffIndex] = { ...newStates[ffIndex], hasD: true };
          } 
          else if (isEnInput) {
            // Update Enable input state (only relevant for DFF, not DFF_NE)
            if (destElement.type === "DFF") {
              newStates[ffIndex] = { ...newStates[ffIndex], hasEn: true };
              
              // Record the time this enable signal was received
              setActiveFlipFlopInputs(prev => ({
                ...prev, 
                [destElement.id]: { 
                  ...(prev[destElement.id] || { D: false, En: false, lastEnUpdateTime: 0 }),
                  En: true,
                  lastEnUpdateTime: currentTime 
                }
              }));
            }
          }
          else if (isClockInput) {
            const ff = newStates[ffIndex];
            
            // Debounce clock to prevent multiple triggers
            if (currentTime - ff.lastClockTime < 50) return prev;
            
            // Update last clock time
            newStates[ffIndex] = { ...ff, lastClockTime: currentTime };
            
            // Apply flip-flop logic on clock edge
            // For DFF (with enable):
            // - Only update output if enable is active
            // For DFF_NE (no enable):
            // - Always update output on clock edge
            
            const shouldUpdateOutput = 
              destElement.type === "DFF_NE" || // Always update for DFF_NE
              (destElement.type === "DFF" && ff.hasEn); // Only update for DFF if enable is active
              
            if (shouldUpdateOutput) {
              newStates[ffIndex] = {
                ...newStates[ffIndex],
                outputValue: ff.hasD, // Set output to D input value
              };
              
              // If output is now true, emit a signal after a small delay
              if (newStates[ffIndex].outputValue) {
                setTimeout(() => {
                  // Find output connection from this flip-flop
                  const outputConn = connections.find((conn) => {
                    const source = elements.find(
                      (el) =>
                        el.id === destElement.id &&
                        el.outputs &&
                        el.outputs.some((output) => output.wireName === conn.name)
                    );
                    return !!source;
                  });

                  if (outputConn) {
                    // Add a new signal on the output wire
                    setActiveSignals((signals) => {
                      const outputElement = elements.find(
                        (el) => el.id === destElement.id
                      );

                      const targetElement = elements.find(
                        (el) =>
                          el.inputs &&
                          el.inputs.some(
                            (input) => input.wireName === outputConn.name
                          )
                      );

                      if (!outputElement || !targetElement) return signals;

                      // Create the signal
                      const path = calculateOrthogonalPath(
                        outputElement,
                        targetElement,
                        outputConn
                      );

                      // Calculate total path length
                      let totalLength = 0;
                      for (let i = 0; i < path.length - 1; i++) {
                        const dx = path[i + 1].x - path[i].x;
                        const dy = path[i + 1].y - path[i].y;
                        totalLength += Math.sqrt(dx * dx + dy * dy);
                      }

                      return [
                        ...signals,
                        {
                          connectionName: outputConn.name,
                          position: 0,
                          points: path,
                          totalLength,
                          createdAt: performance.now(),
                          sourceName: outputElement.name || `element-${outputElement.id}`,
                          destName: targetElement.name || `element-${targetElement.id}`,
                        },
                      ];
                    });
                  }
                }, 100); // Small delay for visual clarity
              }
            }
            
            // Reset D input after processing (regardless of whether output was updated)
            newStates[ffIndex] = {
              ...newStates[ffIndex],
              hasD: false
            };
          }

          return newStates;
        });
      }
    },
    [elements, connections]
  );

  // Preload images when component mounts
  useEffect(() => {
    const imageCache: { [key: string]: HTMLImageElement } = {};
    const themePrefix = isDarkTheme ? "d" : "w"; // 'd' for dark theme, 'w' for white/light theme

    // Create a list of all images to load
    const imagePromises = Object.entries(elementTypeToImageMap).map(
      ([type, imageName]) => {
        // Fix path to use assets in public directory
        const path = `${
          import.meta.env.BASE_URL || ""
        }images/components/${themePrefix}_${imageName}.png`;

        return new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            imageCache[type] = img;
            resolve();
          };
          img.onerror = (e) => {
            toast.error(`Failed to load image: ${path}`);
            console.error(`Failed to load image: ${path}`, e);
            resolve(); // Resolve anyway to not block other images
          };
          img.src = path;
        });
      }
    );

    // When all images are loaded, update the state
    Promise.all(imagePromises).then(() => {
      setComponentImages(imageCache);
    });
  }, [isDarkTheme, elementTypeToImageMap]); // Reload images when theme changes

  // Load data from active example
  useEffect(() => {
    const activeExample = examples.find(
      (example) =>
        example.jsonOutput &&
        activeTabId.includes(example.originalVerilogFile.name.split(".")[0])
    );

    if (activeExample && activeExample.jsonOutput) {
      // Extract elements and connections
      const rawElements = activeExample.jsonOutput.elements;
      const rawConnections = activeExample.jsonOutput.connections;

      // Apply automatic layout to elements based on connections
      const arrangedElements = arrangeElements(rawElements, rawConnections);

      // Set the arranged elements and connections
      setElements(arrangedElements);
      setConnections(rawConnections);

      // Reset zoom and center view
      resetZoom();
    } else {
      // If no example is selected, show warning and clear canvas
      if (activeTabId) {
        toast.warning("No active example found");
        console.warn("No active example found for:", activeTabId);
      }

      // Clear the canvas
      setElements([]);
      setConnections([]);
    }
  }, [activeTabId, examples]);

  // Make sure state is pushed to history after relevant operations
  useEffect(() => {
    if (elementsModified) {
      const currentState = {
        elements,
        connections,
        elementPositions: new Map(
          elements.map((el) => [
            el.id.toString(),
            { x: el.x ?? 0, y: el.y ?? 0 },
          ])
        ),
      };

      pushState(currentState);
      // Reset the modified flag after pushing state
      setElementsModified(false);
    }
  }, [elementsModified, elements, connections, pushState]);

  // Initialize flip-flop states when elements change
  useEffect(() => {
    // Find all flip-flops in the elements
    const flipFlops = elements.filter(
      (el) => el.type === "DFF" || el.type === "DFF_NE"
    );

    // Initialize state for each flip-flop
    setFlipFlopStates(
      flipFlops.map((ff) => ({
        id: ff.id,
        name: ff.name || `flip-flop-${ff.id}`,  // Add a fallback name
        hasD: false,
        hasEn: ff.type === "DFF_NE", // DFF_NE (no enable) always has enable "true"
        outputValue: false,
        lastClockTime: 0,
        type: ff.type, // Store the type to check during reset
      }))
    );
    
    // Also initialize the active flip-flop inputs tracker
    const initialFlipFlopInputs: {[id: number]: {D: boolean, En: boolean, lastEnUpdateTime: number}} = {};
    flipFlops.forEach(ff => {
      initialFlipFlopInputs[ff.id] = {
        D: false,
        En: ff.type === "DFF_NE", // DFF_NE always has enable active
        lastEnUpdateTime: 0
      };
    });
    setActiveFlipFlopInputs(initialFlipFlopInputs);
  }, [elements]);

  // Reset flip-flop states when simulation is reset
  useEffect(() => {
    if (resetTriggered) {
      setFlipFlopStates((prev) =>
        prev.map((ff) => ({
          ...ff,
          hasD: false,
          hasEn: ff.type === "DFF_NE", // Keep always true for DFF_NE
          outputValue: false,
          lastClockTime: 0,
        }))
      );
      
      // Reset active inputs
      setActiveInputs([]);
    }
  }, [resetTriggered]);

  // Handle undo action
  const handleUndo = useCallback(() => {
    const prevState = undo();
    if (prevState) {
      setElements(prevState.elements as IElement[]);
      setConnections(prevState.connections);
    }
  }, [undo]);

  // Handle redo action
  const handleRedo = useCallback(() => {
    const nextState = redo();
    if (nextState) {
      setElements(nextState.elements as IElement[]);
      setConnections(nextState.connections);
    }
  }, [redo]);

  // Handle reset action
  const handleReset = useCallback(() => {
    const initialState = reset();
    setElements(initialState.elements as IElement[]);
    setConnections(initialState.connections);
  }, [reset]);

  // Function to handle zoom from the action bar
  const handleZoomChange = (newZoomPercent: number) => {
    const newZoom = newZoomPercent / 100;
    setZoomLevel(newZoom);
  };

  // Function to reset zoom
  const resetZoom = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  // Function to handle clock frequency change
  const handleClockFrequencyChange = (newFrequency: number) => {
    setClockFrequency(Math.max(1, Math.min(100, newFrequency))); // Limit between 1Hz and 100Hz
  };

  // Handle mouse down event for dragging elements
  const handleMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return; // Only proceed for left mouse button

    const { offsetX, offsetY } = event.nativeEvent;

    // Convert screen coordinates to canvas coordinates
    const canvasX = (offsetX - panOffset.x) / zoomLevel;
    const canvasY = (offsetY - panOffset.y) / zoomLevel;

    // Save the starting position of the click
    setDragStartPos({ x: canvasX, y: canvasY });
    // Reset the drag flag
    setElementWasDragged(false);

    // Find element under the cursor
    const foundElement = elements.find((el) => {
      const size = 50; // Element size
      const x = el.x || 0;
      const y = el.y || 0;

      return (
        canvasX >= x &&
        canvasX <= x + size &&
        canvasY >= y &&
        canvasY <= y + size
      );
    });

    if (foundElement) {
      // Store the clicked element for later (to handle click vs drag)
      setClickedElement(foundElement);

      // Set dragging element regardless of element type
      setDraggingElement(foundElement.id);
    } else {
      setClickedElement(null);
    }
  };

  // Handle mouse move event for dragging elements
  const handleMouseMove = (event: React.MouseEvent) => {
    if (draggingElement === null) return;

    const { offsetX, offsetY } = event.nativeEvent;

    // Convert screen coordinates to canvas coordinates
    const canvasX = (offsetX - panOffset.x) / zoomLevel;
    const canvasY = (offsetY - panOffset.y) / zoomLevel;

    // Check if we've moved enough to consider this a drag
    if (
      dragStartPos &&
      (Math.abs(canvasX - dragStartPos.x) > 5 ||
        Math.abs(canvasY - dragStartPos.y) > 5)
    ) {
      setElementWasDragged(true);
    }

    // Update element position
    setElements((prev) =>
      prev.map((el) =>
        el.id === draggingElement
          ? {
              ...el,
              x: canvasX - 25, // Center element on cursor
              y: canvasY - 25,
            }
          : el
      )
    );
  };

  // Handle mouse up event for dragging elements
  const handleMouseUp = () => {
    // If we have a clicked element and it wasn't dragged, handle it as a click
    if (clickedElement && !elementWasDragged) {
      // If clicking on an input module, toggle its active state
      if (clickedElement.type === "module_input") {
        setActiveInputs((prev) => {
          const isActive = prev.includes(clickedElement.id);
          return isActive
            ? prev.filter((id) => id !== clickedElement.id) // Remove if already active
            : [...prev, clickedElement.id]; // Add if not active
        });
        setElementsModified(true);
      }
    }
    // Otherwise, if dragging ended, update the history
    else if (draggingElement !== null && elementWasDragged) {
      setElementsModified(true);
    }

    // Reset all drag/click state
    setDraggingElement(null);
    setDragStartPos(null);
    setElementWasDragged(false);
    setClickedElement(null);
  };

  // Modified canvas drawing function to use images and orthogonal wire paths
  const drawCanvas = useCallback(() => {
    const canvasRef = canvas.current;
    if (!canvasRef) return;

    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;

    // Clear canvas with appropriate background color
    ctx.fillStyle = isDarkTheme ? "#171717" : "#ffffff";
    ctx.fillRect(0, 0, canvasRef.width, canvasRef.height);

    // Apply transformations (scale and translate)
    ctx.save();
    ctx.translate(panOffset.x, panOffset.y);
    ctx.scale(zoomLevel, zoomLevel);

    // Debug info if no elements
    if (elements.length === 0) {
      ctx.restore();
      ctx.fillStyle = isDarkTheme ? "#ffffff" : "#000000";
      ctx.font = "16px Arial";
      ctx.textAlign = "center";
      ctx.fillText(
        "No elements to display. Select an example from the drawer.",
        canvasRef.width / 2,
        canvasRef.height / 2
      );
      return;
    }

    // Draw connections with orthogonal paths
    ctx.strokeStyle = isDarkTheme ? "rgb(226,226,226)" : "black";
    ctx.lineWidth = 2 / zoomLevel; // Adjust line width based on zoom

    connections.forEach((connection) => {
      // Find source and destination elements for this connection
      const sourceElement = elements.find(
        (el) =>
          el.outputs &&
          el.outputs.some((output) => output.wireName === connection.name)
      );

      const destElement = elements.find(
        (el) =>
          el.inputs &&
          el.inputs.some((input) => input.wireName === connection.name)
      );

      if (sourceElement && destElement) {
        // Use the enhanced path calculation function
        const path = calculateOrthogonalPath(
          sourceElement,
          destElement,
          connection
        );

        // Draw the path
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);

        // Draw all path segments
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x, path[i].y);
        }

        ctx.stroke();
      }
    });

    // Draw elements
    elements.forEach((el) => {
      const x = el.x || 0;
      const y = el.y || 0;
      const size = 50;

      // Determine which image to use, checking if input or output is active
      let elementType = el.type;
      if (el.type === "module_input" && activeInputs.includes(el.id)) {
        elementType = "module_input_en"; // Use enabled input image
      } else if (el.type === "module_output" && activeOutputs[el.id]) {
        elementType = "module_output_en"; // Use enabled output image
      }

      // For flip-flops, use the enabled image if output is true
      if (el.type === "DFF" || el.type === "DFF_NE") {
        const ffState = flipFlopStates.find((ff) => ff.id === el.id);
        if (ffState?.outputValue) {
          // First draw the regular image
          const image = componentImages[elementType];
          if (image) {
            ctx.drawImage(image, x, y, size, size);
          } else {
            let color: string;
            
            // Use type assertion to fix the TypeScript error
            const elementType = el.type as string;
            
            switch (elementType) {
              case "clk":
                color = "blue";
                break;
              case "module_input_en":
                color = "green";
                break;
              case "module_output_en":
                color = "red";
                break;
              case "DFF_NE":
                color = "purple";
                break;
              default:
                color = "gray";
            }

            // Draw element as rectangle with label
            ctx.fillStyle = color;
            ctx.fillRect(x, y, size, size);

            // Draw border
            ctx.strokeStyle = isDarkTheme ? "white" : "black";
            ctx.lineWidth = 1 / zoomLevel;
            ctx.strokeRect(x, y, size, size);
          }

          // Add a green indicator dot for active flip-flops
          ctx.fillStyle = "#00ff00";
          ctx.beginPath();
          ctx.arc(x + size - 10, y + 10, 5, 0, Math.PI * 2);
          ctx.fill();

          // Draw input state indicators
          if (ffState) {
            // Small indicator for D input
            ctx.fillStyle = ffState.hasD ? "#00ff00" : "#ff0000";
            ctx.beginPath();
            ctx.arc(x + 5, y + size * 0.25, 3, 0, Math.PI * 2);
            ctx.fill();

            // Small indicator for En input
            ctx.fillStyle = ffState.hasEn ? "#00ff00" : "#ff0000";
            ctx.beginPath();
            ctx.arc(x + 5, y + size * 0.75, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          return; // Skip the regular drawing code below
        }
      }

      // Get the image for this element type
      const image = componentImages[elementType];

      // If image is loaded, draw it
      if (image) {
        ctx.drawImage(image, x, y, size, size);
      } else {
        // Fallback to colored rectangle if image is not loaded
        let color;
        switch (el.type) {
          case "clk":
            color = "blue";
            break;
          case "module_input":
          case "module_input_en":
            color = "green";
            break;
          case "module_output":
          case "module_output_en":
            color = "red";
            break;
          case "DFF":
          case "DFF_NE":
            color = "purple";
            break;
          default:
            color = "gray";
        }

        // Draw element as rectangle with label
        ctx.fillStyle = color;
        ctx.fillRect(x, y, size, size);

        // Draw border
        ctx.strokeStyle = isDarkTheme ? "white" : "black";
        ctx.lineWidth = 1 / zoomLevel;
        ctx.strokeRect(x, y, size, size);
      }

      // Always draw element name below the image for clarity
      ctx.fillStyle = isDarkTheme ? "white" : "black";
      ctx.font = `${12 / zoomLevel}px Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(el.name || `element-${el.id}`, x + size / 2, y + size + 5);
    });

    // Draw signals as small black circles
    if (runningSimulation) {
      ctx.fillStyle = isDarkTheme ? "#ffffff" : "#000000";

      activeSignals.forEach((signal) => {
        if (signal.position < 1.0 && signal.points.length >= 2) {
          // Calculate the total length of the path (should already be in signal.totalLength)
          const totalLength = signal.totalLength;

          // Calculate distance to travel based on progress
          const targetDistance = totalLength * signal.position;

          // Find the points between which the signal currently is
          let currentDistance = 0;
          let segmentIndex = 0;

          for (let i = 0; i < signal.points.length - 1; i++) {
            const dx = signal.points[i + 1].x - signal.points[i].x;
            const dy = signal.points[i + 1].y - signal.points[i].y;
            const segmentLength = Math.sqrt(dx * dx + dy * dy);

            if (currentDistance + segmentLength >= targetDistance) {
              segmentIndex = i;
              break;
            }

            currentDistance += segmentLength;
          }

          // Calculate position within the current segment
          const p1 = signal.points[segmentIndex];
          const p2 = signal.points[segmentIndex + 1];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const segmentLength = Math.sqrt(dx * dx + dy * dy);
          const segmentProgress =
            (targetDistance - currentDistance) / segmentLength;

          // Calculate the exact position of the signal
          const signalX = p1.x + dx * segmentProgress;
          const signalY = p1.y + dy * segmentProgress;

          // Draw the signal
          ctx.beginPath();
          ctx.arc(signalX, signalY, 4 / zoomLevel, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    ctx.restore();
  }, [
    elements,
    connections,
    panOffset,
    zoomLevel,
    isDarkTheme,
    componentImages,
    runningSimulation,
    activeSignals,
    activeInputs,
    activeOutputs, // Add activeOutputs to dependencies
    flipFlopStates,
  ]);

  // Handle canvas resize
  useEffect(() => {
    function handleResize() {
      if (containerRef.current && canvas.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        canvas.current.width = width;
        canvas.current.height = height;
        setCanvasSize({ width, height });
      }
    }

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Draw canvas whenever necessary
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas, canvasSize, elements]);

  // Add effect to handle simulation running
  useEffect(() => {
    if (!runningSimulation) {
      // Clear all signals when simulation stops
      setActiveSignals([]);
      return;
    }

    // Find the clock element
    const clockElement = elements.find((el) => el.type === "clk");
    if (!clockElement) return;

    // Find all connections that originate from the clock
    const clockConnections = connections.filter((conn) => {
      const sourceElement = elements.find(
        (el) =>
          el.outputs &&
          el.outputs.some((output) => output.wireName === conn.name)
      );
      return sourceElement?.id === clockElement.id;
    });

    // Create a timer to emit signals from the clock and process active inputs
    const clockInterval = setInterval(() => {
      setActiveSignals((prevSignals) => {
        // Check for existing signals on each connection
        const updatedSignals = [...prevSignals];

        // Emit signals from active inputs as well
        const inputConnections = connections.filter((conn) => {
          const sourceElement = elements.find(
            (el) =>
              el.outputs &&
              el.outputs.some((output) => output.wireName === conn.name)
          );
          return (
            sourceElement &&
            sourceElement.type === "module_input" &&
            activeInputs.includes(sourceElement.id)
          );
        });

        // Combine clock connections and input connections for signal generation
        const allSignalSources = [...clockConnections, ...inputConnections];

        allSignalSources.forEach((conn) => {
          // Check if there's already a signal on this connection
          const signalExists = updatedSignals.some(
            (signal) => signal.connectionName === conn.name
          );
          if (signalExists) return; // Don't emit if a signal is already present

          // Find the source and destination elements
          const source = elements.find(
            (el) =>
              el.outputs &&
              el.outputs.some((output) => output.wireName === conn.name)
          );
          const dest = elements.find(
            (el) =>
              el.inputs &&
              el.inputs.some((input) => input.wireName === conn.name)
          );

          if (source && dest) {
            // Create paths and add a new signal
            // ...existing code for creating signals...
            
            // Get port positions for this connection
            const sourcePort = source.outputs?.find(
              (output) => output.wireName === conn.name
            );

            const destPort = dest.inputs?.find(
              (input) => input.wireName === conn.name
            );

            // Calculate path for the signal using actual port positions
            const points = calculateOrthogonalPath(source, dest, conn);

            // Calculate total path length
            let totalLength = 0;
            for (let i = 0; i < points.length - 1; i++) {
              const dx = points[i + 1].x - points[i].x;
              const dy = points[i + 1].y - points[i].y;
              totalLength += Math.sqrt(dx * dx + dy * dy);
            }

            // Create a new signal at the start of the wire
            updatedSignals.push({
              connectionName: conn.name,
              position: 0, // Start at position 0 (0%)
              points,
              totalLength,
              createdAt: performance.now(),
              sourceName: source.name || `element-${source.id}`,
              destName: dest.name || `element-${dest.id}`,
            });
          }
        });

        return updatedSignals;
      });
    }, 1000 / clockFrequency); // Emit signals at the clock frequency

    // Create a timer to move signals along wires
    const signalInterval = setInterval(() => {
      setActiveSignals((prev) => {
        // Move each signal along its wire
        const updatedSignals = prev.map((signal) => {
          // Calculate new position
          const newPosition = signal.position + 0.01 / signalSpeed;

          // If signal just completed (crossed the 1.0 threshold), trigger the handleSignalArrival
          if (signal.position < 1.0 && newPosition >= 1.0) {
            handleSignalArrival(signal);
          }

          return {
            ...signal,
            // Increment position by a percentage that ensures consistent travel time
            position: newPosition,
          };
        });

        // Remove signals that reached the end (position >= 1.0 meaning 100%)
        return updatedSignals.filter((signal) => signal.position < 1.0);
      });
    }, 10); // Update frequently for smooth animation

    return () => {
      clearInterval(clockInterval);
      clearInterval(signalInterval);
    };
  }, [
    runningSimulation,
    elements,
    connections,
    clockFrequency,
    signalSpeed,
    activeInputs,
    handleSignalArrival,
  ]);

  // Add an effect to track and reset enable signals
  useEffect(() => {
    if (!runningSimulation) return;
    
    // Check every 200ms for flip-flops that haven't received an enable signal recently
    const resetInterval = setInterval(() => {
      const now = performance.now();
      const SIGNAL_TIMEOUT = 500; // Consider signal gone after 500ms
      
      // For each flip-flop with DFF type (not DFF_NE), check if enable signal is stale
      setFlipFlopStates(prev => {
        let changed = false;
        const newStates = [...prev];
        
        newStates.forEach((ff, index) => {
          // Skip DFF_NE which always has enable on
          if (ff.type === "DFF_NE") return;
          
          // Get the signal state for this flip-flop
          const ffInputs = activeFlipFlopInputs[ff.id];
          
          // If this flip-flop has enable input and it's stale (too old)
          if (ffInputs && ffInputs.En && now - ffInputs.lastEnUpdateTime > SIGNAL_TIMEOUT) {
            // Mark the enable signal as inactive
            setActiveFlipFlopInputs(prev => ({
              ...prev,
              [ff.id]: {
                ...prev[ff.id],
                En: false
              }
            }));
            
            // Also update the flip-flop state
            newStates[index] = {
              ...newStates[index],
              hasEn: false
            };
            
            changed = true;
          }
        });
        
        return changed ? newStates : prev;
      });
    }, 200);
    
    return () => clearInterval(resetInterval);
  }, [runningSimulation, activeFlipFlopInputs]);

  // Add an effect to reset output signals after a timeout
  useEffect(() => {
    if (!runningSimulation) {
      // Clear all active outputs when simulation stops
      setActiveOutputs({});
      return;
    }
    
    // Check every 500ms for output signals that have timed out
    const resetOutputsInterval = setInterval(() => {
      const now = performance.now();
      const OUTPUT_SIGNAL_TIMEOUT = 500; // Output stays active for 500ms
      
      setActiveOutputs(prev => {
        const newActiveOutputs = { ...prev };
        let changed = false;
        
        // Check each active output
        Object.entries(prev).forEach(([id, timestamp]) => {
          if (now - timestamp > OUTPUT_SIGNAL_TIMEOUT) {
            // Remove outputs that have timed out
            delete newActiveOutputs[Number(id)];
            changed = true;
          }
        });
        
        return changed ? newActiveOutputs : prev;
      });
    }, 200);
    
    return () => clearInterval(resetOutputsInterval);
  }, [runningSimulation]);

  // Reset active outputs when simulation is reset
  useEffect(() => {
    if (resetTriggered) {
      // Reset active outputs
      setActiveOutputs({});
    }
  }, [resetTriggered]);

  // Add a button to the action bar for auto-arranging elements
  const handleAutoArrange = useCallback(() => {
    // Arrange elements and update them
    const arrangedElements = arrangeElements(elements, connections);
    setElements(arrangedElements);
    setElementsModified(true);
  }, [elements, connections]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[88vh] bg-gray-100 dark:bg-neutral-800"
    >
      <canvas
        ref={canvas}
        className="border border-neutral-400 dark:border-neutral-900 bg-white dark:bg-neutral-900 w-full h-full"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
      <div className="relative">
        <div className="absolute bottom-2 left-6">
          <CanvasActionBar
            zoom={Math.round(zoomLevel * 100)}
            onZoomChange={(delta) =>
              handleZoomChange(Math.round(zoomLevel * 100) + delta)
            }
            onResetZoom={resetZoom}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onReset={handleReset}
            canUndo={canUndo}
            canRedo={canRedo}
            clockFrequency={clockFrequency}
            onClockFrequencyChange={handleClockFrequencyChange}
            onAutoArrange={handleAutoArrange}
          />
        </div>
      </div>
    </div>
  );
}
