"use client";

import React, { useState, useEffect } from 'react';
import { buildWsUrl } from '@/lib/config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Sparkles, 
  Cpu, 
  Zap, 
  Settings, 
  Play, 
  Pause, 
  CheckCircle2, 
  XCircle,
  Clock,
  TrendingUp,
  Brain,
  Network
} from 'lucide-react';

interface ModelPreset {
  name: string;
  description: string;
  orchestrator: string;
  worker: string;
  cost: string;
  speed: string;
}

interface QuantumStats {
  plans_generated: number;
  actions_taken: number;
  successful_actions: number;
  failed_actions: number;
  quantum_planning_time: number;
  quantum_routing_time: number;
}

interface TreeStatus {
  tree_id: string;
  status: string;
  progress: number;
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
  ready_tasks: number;
  executing_tasks: number;
  time_consumed: number;
  time_remaining: number;
}

const MODEL_PRESETS: ModelPreset[] = [
  {
    name: 'hybrid',
    description: 'Azure for orchestration, local for workers (Recommended)',
    orchestrator: 'DeepSeek R1',
    worker: 'Qwen 2.5 14B',
    cost: 'Medium',
    speed: 'Fast'
  },
  {
    name: 'azure_only',
    description: 'All Azure models for maximum performance',
    orchestrator: 'DeepSeek R1',
    worker: 'GPT-4o',
    cost: 'High',
    speed: 'Fastest'
  },
  {
    name: 'local_only',
    description: 'All local models for zero cost',
    orchestrator: 'Qwen 2.5 32B',
    worker: 'Qwen 2.5 14B',
    cost: 'Free',
    speed: 'Medium'
  },
  {
    name: 'cost_optimized',
    description: 'Smallest models for minimal cost',
    orchestrator: 'Qwen 2.5 7B',
    worker: 'Qwen 2.5 7B',
    cost: 'Free',
    speed: 'Slower'
  },
  {
    name: 'performance',
    description: 'Best models for highest quality',
    orchestrator: 'DeepSeek R1',
    worker: 'GPT-4o',
    cost: 'Highest',
    speed: 'Fastest'
  }
];

export default function QuantumDecompositionUI() {
  const [description, setDescription] = useState('');
  const [deliverableType, setDeliverableType] = useState('codebase');
  const [timeBudget, setTimeBudget] = useState(10);
  const [enableQuantum, setEnableQuantum] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState('hybrid');
  
  const [isDecomposing, setIsDecomposing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [treeId, setTreeId] = useState<string | null>(null);
  const [treeStatus, setTreeStatus] = useState<TreeStatus | null>(null);
  const [quantumStats, setQuantumStats] = useState<QuantumStats | null>(null);
  
  const [ws, setWs] = useState<WebSocket | null>(null);

  // WebSocket connection for real-time updates
  useEffect(() => {
    if (treeId && isExecuting) {
      const websocket = new WebSocket(buildWsUrl(`/api/quantum/ws/tree/${treeId}`));
      
      websocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        setTreeStatus(data);
      };
      
      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      setWs(websocket);
      
      return () => {
        websocket.close();
      };
    }
  }, [treeId, isExecuting]);

  const handleDecompose = async () => {
    setIsDecomposing(true);
    
    try {
      const response = await fetch('/api/quantum/decompose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          deliverable_type: deliverableType,
          time_budget_hours: timeBudget,
          enable_quantum: enableQuantum,
          model_preset: selectedPreset
        })
      });
      
      const data = await response.json();
      setTreeId(data.tree_id);
      
      // Fetch initial status
      const statusResponse = await fetch(`/api/quantum/tree/${data.tree_id}/status`);
      const statusData = await statusResponse.json();
      setTreeStatus(statusData);
      
    } catch (error) {
      console.error('Decomposition error:', error);
    } finally {
      setIsDecomposing(false);
    }
  };

  const handleExecute = async () => {
    if (!treeId) return;
    
    setIsExecuting(true);
    
    try {
      const response = await fetch('/api/quantum/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tree_id: treeId,
          max_iterations: 1000
        })
      });
      
      const data = await response.json();
      setQuantumStats(data.quantum_stats);
      
    } catch (error) {
      console.error('Execution error:', error);
    } finally {
      setIsExecuting(false);
    }
  };

  const selectedPresetInfo = MODEL_PRESETS.find(p => p.name === selectedPreset);

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold flex items-center gap-3">
            <Sparkles className="w-10 h-10 text-purple-500" />
            Quantum-Enhanced Task Decomposition
          </h1>
          <p className="text-muted-foreground mt-2">
            AI-powered project planning with quantum optimization
          </p>
        </div>
        {enableQuantum && (
          <Badge variant="outline" className="text-lg px-4 py-2">
            <Cpu className="w-4 h-4 mr-2" />
            Quantum Enabled
          </Badge>
        )}
      </div>

      <Tabs defaultValue="configure" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="configure">Configure</TabsTrigger>
          <TabsTrigger value="execute" className={!treeId ? 'opacity-50 cursor-not-allowed' : ''}>Execute</TabsTrigger>
          <TabsTrigger value="monitor" className={!treeStatus ? 'opacity-50 cursor-not-allowed' : ''}>Monitor</TabsTrigger>
        </TabsList>

        {/* Configuration Tab */}
        <TabsContent value="configure" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Project Configuration */}
            <Card>
              <CardHeader>
                <CardTitle>Project Configuration</CardTitle>
                <CardDescription>
                  Describe your project and set parameters
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="description">Project Description</Label>
                  <textarea
                    id="description"
                    placeholder="Build a modern e-commerce platform with React, Node.js, and PostgreSQL..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={6}
                    className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="deliverable">Deliverable Type</Label>
                    <Select value={deliverableType} onValueChange={setDeliverableType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="codebase">Codebase</SelectItem>
                        <SelectItem value="website">Website</SelectItem>
                        <SelectItem value="document">Document</SelectItem>
                        <SelectItem value="api">API</SelectItem>
                        <SelectItem value="dataset">Dataset</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeBudget">Time Budget (hours)</Label>
                    <Input
                      id="timeBudget"
                      type="number"
                      value={timeBudget}
                      onChange={(e) => setTimeBudget(Number(e.target.value))}
                      min={1}
                      max={100}
                    />
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="quantum"
                    checked={enableQuantum}
                    onChange={(e) => setEnableQuantum(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="quantum" className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-yellow-500" />
                    Enable Quantum Optimization
                  </Label>
                </div>

                <Button
                  onClick={handleDecompose}
                  disabled={isDecomposing || !description}
                  className="w-full"
                  size="lg"
                >
                  {isDecomposing ? (
                    <>
                      <Cpu className="w-4 h-4 mr-2 animate-spin" />
                      Decomposing...
                    </>
                  ) : (
                    <>
                      <Brain className="w-4 h-4 mr-2" />
                      Decompose Project
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Model Selection */}
            <Card>
              <CardHeader>
                <CardTitle>Model Configuration</CardTitle>
                <CardDescription>
                  Choose models for different agent types
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Model Preset</Label>
                  <Select value={selectedPreset} onValueChange={setSelectedPreset}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_PRESETS.map((preset) => (
                        <SelectItem key={preset.name} value={preset.name}>
                          {preset.name.replace('_', ' ').toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedPresetInfo && (
                  <div className="space-y-4 p-4 bg-muted rounded-lg">
                    <p className="text-sm text-muted-foreground">
                      {selectedPresetInfo.description}
                    </p>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-xs">Orchestrator</Label>
                        <p className="font-medium">{selectedPresetInfo.orchestrator}</p>
                      </div>
                      <div>
                        <Label className="text-xs">Worker</Label>
                        <p className="font-medium">{selectedPresetInfo.worker}</p>
                      </div>
                    </div>

                    <div className="flex gap-4">
                      <Badge variant="outline">
                        Cost: {selectedPresetInfo.cost}
                      </Badge>
                      <Badge variant="outline">
                        Speed: {selectedPresetInfo.speed}
                      </Badge>
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    Advanced Settings
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    Custom model configurations available via API
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Execution Tab */}
        <TabsContent value="execute" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Execute Decomposed Project</CardTitle>
              <CardDescription>
                Run the quantum-optimized execution plan
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {treeStatus && (
                <div className="grid grid-cols-4 gap-4">
                  <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                    <div className="text-2xl font-bold">{treeStatus.total_nodes}</div>
                    <div className="text-sm text-muted-foreground">Total Tasks</div>
                  </div>
                  <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                    <div className="text-2xl font-bold">{treeStatus.ready_tasks}</div>
                    <div className="text-sm text-muted-foreground">Ready</div>
                  </div>
                  <div className="p-4 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                    <div className="text-2xl font-bold">{treeStatus.executing_tasks}</div>
                    <div className="text-sm text-muted-foreground">Executing</div>
                  </div>
                  <div className="p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
                    <div className="text-2xl font-bold">{treeStatus.completed_nodes}</div>
                    <div className="text-sm text-muted-foreground">Completed</div>
                  </div>
                </div>
              )}

              <Button
                onClick={handleExecute}
                disabled={isExecuting || !treeId}
                className="w-full"
                size="lg"
              >
                {isExecuting ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" />
                    Executing...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Start Execution
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Monitor Tab */}
        <TabsContent value="monitor" className="space-y-6">
          {treeStatus && (
            <>
              {/* Progress Overview */}
              <Card>
                <CardHeader>
                  <CardTitle>Execution Progress</CardTitle>
                  <CardDescription>Real-time project status</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Overall Progress</span>
                      <span className="font-medium">{treeStatus.progress.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-3">
                      <div
                        className="bg-primary h-3 rounded-full transition-all duration-300"
                        style={{ width: `${treeStatus.progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="w-5 h-5 text-green-500" />
                      <div>
                        <div className="font-medium">{treeStatus.completed_nodes}</div>
                        <div className="text-sm text-muted-foreground">Completed</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <XCircle className="w-5 h-5 text-red-500" />
                      <div>
                        <div className="font-medium">{treeStatus.failed_nodes}</div>
                        <div className="text-sm text-muted-foreground">Failed</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Clock className="w-5 h-5 text-blue-500" />
                      <div>
                        <div className="font-medium">{(treeStatus.time_consumed / 3600).toFixed(1)}h</div>
                        <div className="text-sm text-muted-foreground">Time Used</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <TrendingUp className="w-5 h-5 text-purple-500" />
                      <div>
                        <div className="font-medium">{(treeStatus.time_remaining / 3600).toFixed(1)}h</div>
                        <div className="text-sm text-muted-foreground">Remaining</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Quantum Stats */}
              {quantumStats && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Network className="w-5 h-5 text-purple-500" />
                      Quantum Optimization Stats
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
                        <div className="text-2xl font-bold">{quantumStats.plans_generated}</div>
                        <div className="text-sm text-muted-foreground">Plans Generated</div>
                      </div>
                      <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                        <div className="text-2xl font-bold">{quantumStats.actions_taken}</div>
                        <div className="text-sm text-muted-foreground">Actions Taken</div>
                      </div>
                      <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                        <div className="text-2xl font-bold">
                          {((quantumStats.successful_actions / quantumStats.actions_taken) * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-muted-foreground">Success Rate</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Made with Bob
