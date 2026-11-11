"use client";

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  Brain, 
  TrendingUp, 
  Zap, 
  Target, 
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles
} from 'lucide-react';

interface RouterMetrics {
  current_accuracy: number;
  total_decisions: number;
  successful_decisions: number;
  failed_decisions: number;
  avg_confidence: number;
  learning_rate: number;
  epsilon: number;
  recent_accuracy: number; // Last 100 decisions
  improvement_rate: number; // % improvement per 1000 decisions
  action_distribution: Record<string, number>;
  thinking_style_usage: Record<string, number>;
}

interface HistoricalPoint {
  timestamp: number;
  accuracy: number;
  decisions: number;
}

interface QuantumRouterLearningProps {
  treeId?: string;
  refreshInterval?: number;
}

export default function QuantumRouterLearning({ 
  treeId, 
  refreshInterval = 2000 
}: QuantumRouterLearningProps) {
  const [metrics, setMetrics] = useState<RouterMetrics | null>(null);
  const [history, setHistory] = useState<HistoricalPoint[]>([]);
  const [isLearning, setIsLearning] = useState(false);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch(`/api/quantum/router/metrics${treeId ? `?tree_id=${treeId}` : ''}`);
        if (response.ok) {
          const data = await response.json();
          setMetrics(data);
          
          // Update history
          setHistory(prev => {
            const newPoint: HistoricalPoint = {
              timestamp: Date.now(),
              accuracy: data.current_accuracy,
              decisions: data.total_decisions
            };
            const updated = [...prev, newPoint].slice(-50); // Keep last 50 points
            return updated;
          });
          
          // Check if actively learning
          setIsLearning(data.total_decisions > 0 && data.epsilon > 0.01);
        }
      } catch (error) {
        console.error('Failed to fetch router metrics:', error);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, refreshInterval);
    return () => clearInterval(interval);
  }, [treeId, refreshInterval]);

  if (!metrics) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-purple-500" />
            Quantum Router Learning
          </CardTitle>
          <CardDescription>Loading metrics...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const accuracyColor = 
    metrics.current_accuracy >= 0.95 ? 'text-green-500' :
    metrics.current_accuracy >= 0.85 ? 'text-blue-500' :
    metrics.current_accuracy >= 0.70 ? 'text-yellow-500' :
    'text-red-500';

  const accuracyBgColor = 
    metrics.current_accuracy >= 0.95 ? 'bg-green-500' :
    metrics.current_accuracy >= 0.85 ? 'bg-blue-500' :
    metrics.current_accuracy >= 0.70 ? 'bg-yellow-500' :
    'bg-red-500';

  return (
    <div className="space-y-4">
      {/* Main Accuracy Display - PROMINENT */}
      <Card className="border-2 border-purple-500 shadow-lg bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950 dark:to-blue-950">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Brain className="h-7 w-7 text-purple-500 animate-pulse" />
              Quantum Router Intelligence
              {isLearning && (
                <Badge variant="outline" className="ml-2 animate-pulse border-green-500 text-green-500">
                  <Sparkles className="h-3 w-3 mr-1" />
                  Learning
                </Badge>
              )}
            </CardTitle>
            <Badge variant="secondary" className="text-sm">
              {metrics.total_decisions.toLocaleString()} decisions
            </Badge>
          </div>
          <CardDescription>
            Real-time quantum-enhanced decision making with online learning
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Massive Accuracy Display */}
          <div className="text-center py-6 bg-white dark:bg-gray-900 rounded-lg border-2 border-purple-200 dark:border-purple-800">
            <div className="text-sm text-gray-500 mb-2 font-medium">CURRENT ACCURACY</div>
            <div className={`text-7xl font-bold ${accuracyColor} mb-2`}>
              {(metrics.current_accuracy * 100).toFixed(1)}%
            </div>
            <div className="flex items-center justify-center gap-4 text-sm text-gray-600">
              <div className="flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                {metrics.successful_decisions} correct
              </div>
              <div className="flex items-center gap-1">
                <XCircle className="h-4 w-4 text-red-500" />
                {metrics.failed_decisions} incorrect
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Learning Progress</span>
              <span className="font-medium">{(metrics.current_accuracy * 100).toFixed(1)}% / 100%</span>
            </div>
            <Progress 
              value={metrics.current_accuracy * 100} 
              className="h-3"
              indicatorClassName={accuracyBgColor}
            />
          </div>

          {/* Key Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                <Target className="h-4 w-4" />
                Recent Accuracy
              </div>
              <div className="text-2xl font-bold">
                {(metrics.recent_accuracy * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">Last 100 decisions</div>
            </div>

            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                <TrendingUp className="h-4 w-4" />
                Improvement
              </div>
              <div className="text-2xl font-bold text-green-500">
                +{(metrics.improvement_rate * 100).toFixed(2)}%
              </div>
              <div className="text-xs text-gray-500">Per 1K decisions</div>
            </div>

            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                <Zap className="h-4 w-4" />
                Confidence
              </div>
              <div className="text-2xl font-bold text-blue-500">
                {(metrics.avg_confidence * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">Average</div>
            </div>

            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                <Activity className="h-4 w-4" />
                Exploration
              </div>
              <div className="text-2xl font-bold text-purple-500">
                {(metrics.epsilon * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">ε-greedy</div>
            </div>
          </div>

          {/* Learning Curve Visualization */}
          {history.length > 1 && (
            <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-4 w-4 text-purple-500" />
                <span className="font-medium">Learning Curve</span>
              </div>
              <div className="relative h-32">
                <svg className="w-full h-full" viewBox="0 0 400 100" preserveAspectRatio="none">
                  {/* Grid lines */}
                  <line x1="0" y1="0" x2="400" y2="0" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
                  <line x1="0" y1="25" x2="400" y2="25" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
                  <line x1="0" y1="50" x2="400" y2="50" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
                  <line x1="0" y1="75" x2="400" y2="75" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
                  <line x1="0" y1="100" x2="400" y2="100" stroke="currentColor" strokeWidth="0.5" opacity="0.2" />
                  
                  {/* Accuracy line */}
                  <polyline
                    points={history.map((point, i) => {
                      const x = (i / (history.length - 1)) * 400;
                      const y = 100 - (point.accuracy * 100);
                      return `${x},${y}`;
                    }).join(' ')}
                    fill="none"
                    stroke="rgb(168, 85, 247)"
                    strokeWidth="2"
                  />
                  
                  {/* Fill area */}
                  <polygon
                    points={[
                      '0,100',
                      ...history.map((point, i) => {
                        const x = (i / (history.length - 1)) * 400;
                        const y = 100 - (point.accuracy * 100);
                        return `${x},${y}`;
                      }),
                      '400,100'
                    ].join(' ')}
                    fill="rgb(168, 85, 247)"
                    opacity="0.1"
                  />
                </svg>
                
                {/* Y-axis labels */}
                <div className="absolute left-0 top-0 text-xs text-gray-500">100%</div>
                <div className="absolute left-0 top-1/4 text-xs text-gray-500">75%</div>
                <div className="absolute left-0 top-1/2 text-xs text-gray-500">50%</div>
                <div className="absolute left-0 top-3/4 text-xs text-gray-500">25%</div>
                <div className="absolute left-0 bottom-0 text-xs text-gray-500">0%</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Action Distribution</CardTitle>
          <CardDescription>Most frequently selected actions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Object.entries(metrics.action_distribution)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 8)
              .map(([action, count]) => {
                const percentage = (count / metrics.total_decisions) * 100;
                return (
                  <div key={action} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">{action.replace(/_/g, ' ')}</span>
                      <span className="text-gray-500">{count} ({percentage.toFixed(1)}%)</span>
                    </div>
                    <Progress value={percentage} className="h-2" />
                  </div>
                );
              })}
          </div>
        </CardContent>
      </Card>

      {/* Thinking Styles */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Thinking Styles</CardTitle>
          <CardDescription>Decision-making approaches used</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {Object.entries(metrics.thinking_style_usage)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([style, count]) => (
                <Badge key={style} variant="secondary" className="text-xs">
                  {style.replace(/_/g, ' ')} ({count})
                </Badge>
              ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Made with Bob
