'use client';
import AppDecisionTree from '@/app/DecisionTreeViz';
import DeviceDecisionApp from "@/app/DeviceDecisionApp";

export default function Page() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center mb-8 text-gray-800">
          Device Decision Tree & App
        </h1>
        
        <div className="space-y-8">
          {/* Device Decision App Section - Top */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-xl font-semibold mb-4 text-gray-700">
              Device Decision App
            </h2>
            <div className="border rounded-lg p-4 bg-gray-50">
              <DeviceDecisionApp />
            </div>
          </div>
          
          {/* Decision Tree Section - Bottom */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-xl font-semibold mb-4 text-gray-700">
              Decision Tree Visualization
            </h2>
            <div className="border rounded-lg p-4 bg-gray-50">
              <AppDecisionTree />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
