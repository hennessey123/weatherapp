'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Loader2 } from 'lucide-react'

import { searchLocations, type GeocodeMatch } from '@/app/actions/geocode'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

export function LocationSearch({
  onSelect,
}: {
  onSelect: (match: GeocodeMatch) => void
}) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const debounced = useDebouncedValue(input, 300)

  const { data, isFetching } = useQuery({
    queryKey: ['geocode', debounced],
    queryFn: () => searchLocations(debounced),
    enabled: debounced.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
  })

  const results = data ?? []

  return (
    <div className="relative w-full max-w-xl">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
        <Input
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search a US city or ZIP…"
          className="pl-9 pr-9 h-11"
        />
      </div>

      {open && debounced.trim().length >= 2 && (
        <div className="absolute z-10 mt-2 w-full rounded-md border bg-background shadow-md">
          <Command shouldFilter={false}>
            <CommandList>
              {results.length === 0 && !isFetching && (
                <CommandEmpty>No matches.</CommandEmpty>
              )}
              {results.length > 0 && (
                <CommandGroup heading="Locations">
                  {results.map((m) => (
                    <CommandItem
                      key={`${m.lat},${m.lon}-${m.matchedAddress}`}
                      value={m.matchedAddress}
                      onSelect={() => {
                        setInput(m.matchedAddress)
                        onSelect(m)
                        setOpen(false)
                      }}
                    >
                      <div className="flex flex-col">
                        <span className="text-sm">{m.matchedAddress}</span>
                        <span className="text-xs text-muted-foreground">
                          {m.lat.toFixed(4)}, {m.lon.toFixed(4)}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}
