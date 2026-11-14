'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DECK_DIALOG } from '@/components/ui/deck-dialog';
import { SERIF_NOTES_CLASS, SERIF_TITLE_CLASS } from '@/components/planner/surface';
import { toast } from 'sonner';

type ReportType = 'bug' | 'feature';

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BugReportDialog({ open, onOpenChange }: BugReportDialogProps) {
  const [type, setType] = useState<ReportType>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [showSteps, setShowSteps] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setTitle('');
      setDescription('');
      setSteps('');
      setShowSteps(false);
      setType('bug');
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          steps: type === 'bug' && steps.trim() ? steps.trim() : undefined,
          type,
        }),
      });
      if (res.ok) {
        if (type === 'bug') {
          toast.success("Bug reported. We'll look into it 🐉");
        } else {
          toast.success('Feature request sent. Thanks for the idea 🐉');
        }
        handleOpenChange(false);
      } else {
        toast.error('Failed to send. Try again?');
      }
    } catch {
      toast.error('Failed to send. Try again?');
    } finally {
      setLoading(false);
    }
  };

  const isBug = type === 'bug';
  const segment = (value: ReportType, label: string) => (
    <button
      type="button"
      aria-pressed={type === value}
      onClick={() => setType(value)}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        type === value
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );

  // Written like the add dialog (the dialog restyle's round 2, 2026-11-07):
  // the title is the serif line you type straight into, the description sits
  // under it like Notes, and the deck holds the steps chip and the keys.
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={DECK_DIALOG.content}>
        <div className={DECK_DIALOG.body}>
          <DialogHeader className="text-left">
            <DialogTitle className={DECK_DIALOG.title}>Share feedback</DialogTitle>
            <DialogDescription className="sr-only">
              Report a bug or request a feature.
            </DialogDescription>
          </DialogHeader>

          <div className="bg-muted flex w-fit gap-0.5 rounded-lg p-0.5">
            {segment('bug', 'Bug report')}
            {segment('feature', 'Feature request')}
          </div>

          <Input
            id="report-title"
            aria-label="Title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isBug ? 'What went wrong?' : 'What would you like to see?'}
            className={SERIF_TITLE_CLASS}
          />

          <Textarea
            id="report-description"
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              isBug
                ? 'Describe the bug and what you expected to happen'
                : 'Describe the feature and why it would be useful'
            }
            rows={3}
            className={SERIF_NOTES_CLASS}
          />

          {isBug && showSteps && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-steps" className="text-muted-foreground text-xs font-medium">
                Steps to reproduce
              </Label>
              <Textarea
                id="report-steps"
                autoFocus
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder="1. Go to...&#10;2. Click on...&#10;3. See error"
                rows={3}
                className={SERIF_NOTES_CLASS}
              />
            </div>
          )}
        </div>

        <div data-dialog-deck className={DECK_DIALOG.deck}>
          <div className={DECK_DIALOG.deckLead}>
            {isBug && !showSteps && (
              <button type="button" onClick={() => setShowSteps(true)} className={DECK_DIALOG.chip}>
                <Plus aria-hidden />
                Steps to reproduce
              </button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!title.trim() || loading}>
            {loading ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
