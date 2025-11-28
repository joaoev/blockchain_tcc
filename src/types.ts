export type ProcessingType = "UHT" | "PASTEURIZED";

export interface LabResults {
  cbt?: number;       
  ccs?: number;       
  acidity?: number;  
  density?: number;   
  antibiotics?: boolean; 
  fraudFlags?: string[]; 
  timestamp: string;
  actorMSP: string;
}

export interface TransportEvent {
  from: string;           
  to: string;             
  temperatureC?: number;  
  volumeLiters?: number;
  timestamp: string;
  actorMSP: string;
}

export interface MilkBatch {
  docType: "milkBatch";
  batchId: string;
  producerId: string;
  createdAt: string;        
  volumeLiters: number;

  
  approved?: boolean;
  processing?: ProcessingType;
  processedAt?: string;
  expiresAt?: string;

 
  lastFarmTempC?: number;


  transports: TransportEvent[];
  labResults: LabResults[];

  
  currentLocation: string;
  retailReceivedAt?: string;

  // bloqueio após aprovação para evitar mutações indevidas
  lockedFields?: string[]; 
}
