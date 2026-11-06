"""Agent-related data schemas."""

from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional


class SharedContext(BaseModel):
    """Shared context passed between agents"""
    document_text: str
    analysis_stage: str = "starting"
    previous_outputs: Dict[str, str] = Field(default_factory=dict)
    session_id: Optional[str] = None
    # The outer run's RunConfig, for sub-agents. It holds live model clients, so
    # it is typed Any to skip validation and excluded from serialization.
    run_config: Any = Field(default=None, exclude=True)


class AgentDecision(BaseModel):
    """Decision made by routing agent"""
    action: str  # "analyze_document" or "no_document_found"
    reasoning: str
    confidence_score: float = 0.8


class ProcessingStatus(BaseModel):
    """Status of a processing step"""
    step: str
    status: str  # "pending", "processing", "completed", "failed"
    message: str
    progress: int = 0  # 0-100
    details: Dict[str, str] = Field(default_factory=dict)
