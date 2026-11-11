import { createContext, useContext } from 'react';
import type { Cluster, Capability } from './types';
export interface ConsoleContextType {
  cluster?: Cluster;
  clusterId: string;
  clusters: Cluster[];
  username: string;
  isAdmin: boolean;
  can: (cap: Capability, clusterId?: string) => boolean;
  dark: boolean;
  go: (path: string, clusterId?: string) => void;
  refresh: () => void;
}
export const ConsoleContext = createContext<ConsoleContextType>({
  clusters: [],
  clusterId: '',
  username: '',
  isAdmin: false,
  can: () => false,
  dark: false,
  go: () => {},
  refresh: () => {},
});
export const useConsole = () => useContext(ConsoleContext);
