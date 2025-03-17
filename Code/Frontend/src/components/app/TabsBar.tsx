import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { tabs } from "@/data/sample-tabs";

export default function TabsBar({ setActiveTabId }: { setActiveTabId: (id: string) => void }) {
  const [activeTabs, setActiveTabs] = useState(tabs);
  const [selectedTab, setSelectedTab] = useState<string>(tabs[0]?.id || "");

  // When a tab is clicked, update both local state and parent component
  const handleTabClick = (id: string) => {
    setSelectedTab(id);
    setActiveTabId(id);
  };

  const removeTab = (id: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent tab selection when removing
    const newTabs = activeTabs.filter((tab) => tab.id !== id);
    setActiveTabs(newTabs);
    
    // If the removed tab was selected, select another tab
    if (id === selectedTab && newTabs.length > 0) {
      setSelectedTab(newTabs[0].id);
      setActiveTabId(newTabs[0].id);
    }
  };

  return (
    <div className="flex border-b overflow-hidden shadow-md h-[5vh]">
      {activeTabs.map((tab) => (
        <div
          key={tab.id}
          className={cn(
            "flex items-center px-4 py-2 border-r cursor-pointer",
            selectedTab === tab.id ? "bg-gray-100 dark:bg-neutral-700" : ""
          )}
          onClick={() => handleTabClick(tab.id)}
        >
          <span className="mr-2">{tab.name}</span>
          <X
            className="w-4 h-4 cursor-pointer"
            onClick={(e) => removeTab(tab.id, e)}
          />
        </div>
      ))}
    </div>
  );
}
