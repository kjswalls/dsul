'use client';

import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md border-border">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5" />
            Share feedback 🐛
          </DialogTitle>
          <DialogDescription className="sr-only">
            Report a bug or request a feature.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Type toggle */}
          <div className="flex gap-1 p-1 rounded-lg bg-muted w-fit">
            <button
              onClick={() => setType('bug')}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                type === 'bug'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Bug report
            </button>
            <button
              onClick={() => setType('feature')}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                type === 'feature'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Feature request
            </button>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="report-title" className="text-sm">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={type === 'bug' ? 'What went wrong?' : 'What would you like to see?'}
              className="text-sm"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="report-description" className="text-sm">
              Description
            </Label>
            <Textarea
              id="report-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                type === 'bug'
                  ? 'Describe the bug and what you expected to happen...'
                  : 'Describe the feature and why it would be useful...'
              }
              className="text-sm min-h-[80px] resize-none"
            />
          </div>

          {/* Steps to reproduce — bug only */}
          {type === 'bug' && (
            <div className="space-y-1.5">
              {!showSteps ? (
                <button
                  onClick={() => setShowSteps(true)}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  + Add steps to reproduce
                </button>
              ) : (
                <>
                  <Label htmlFor="report-steps" className="text-sm">
                    Steps to reproduce
                  </Label>
                  <Textarea
                    id="report-steps"
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder="1. Go to...&#10;2. Click on...&#10;3. See error"
                    className="text-sm min-h-[80px] resize-none"
                  />
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!title.trim() || loading}
          >
            {loading ? 'Sending…' : type === 'bug' ? 'Send bug report' : 'Send feature request'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
